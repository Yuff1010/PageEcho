"""Synthetic feedback exercises validation; these labels never enter real reports."""

import copy
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
import wave

from review_original import create_output, main, score_review, strict_json, verify_clips


def fixture(count=1):
    samples = []
    for index in range(count):
        samples.append({
            "id": f"episode-1-{index}", "episodeId": "test-episode", "audioHash": "a" * 64,
            "originalHash": "b" * 64, "clipHash": "c" * 64,
            "clipStartMs": 0, "targetStartMs": 1000, "targetEndMs": 2000, "clipEndMs": 3000,
            "asrText": "山路。", "selected": {"first": index, "last": index, "method": "auto"},
            "mappedText": "山路。",
        })
    manifest = {"samples": samples}
    feedback = {"status": "unreviewed", "sourceManifestHash": "f" * 64, "samples": []}
    for sample in samples:
        feedback["samples"].append({
            **{key: sample[key] for key in ("id", "episodeId", "audioHash", "originalHash", "clipHash", "targetStartMs", "targetEndMs")},
            "humanReview": {"listened": False, "spokenText": None, "mappingCorrect": None, "startErrorMs": None, "endErrorMs": None, "notes": None},
        })
    return manifest, feedback


class ListeningReviewTests(unittest.TestCase):
    def test_same_millisecond_runs_get_distinct_atomic_output_directories(self):
        with tempfile.TemporaryDirectory() as root:
            with patch("review_original.datetime") as clock:
                clock.now.return_value = datetime(2026, 10, 21, tzinfo=timezone.utc)
                first, second = create_output(base=root), create_output(base=root)
            self.assertNotEqual(first, second)
            self.assertTrue(first.is_dir() and second.is_dir())
            self.assertTrue(first.name.startswith("2026-10-21T00-00-00.000Z-"))

    def test_blank_and_forged_pass_status_do_not_become_quality_scores(self):
        manifest, feedback = fixture(3)
        feedback["status"] = "passed"
        before = copy.deepcopy((manifest, feedback))
        report = score_review(manifest, feedback, "f" * 64)
        self.assertEqual(report["reviewStatus"], "unreviewed")
        self.assertEqual(report["acceptance"], "not-evaluated")
        self.assertIsNone(report["text"]["cer"])
        self.assertIsNone(report["timing"]["start"])
        self.assertEqual(report["mapping"]["auto"]["unknown"], 3)
        self.assertIsNone(report["mapping"]["auto"]["correctFractionAmongReviewed"])
        self.assertEqual((manifest, feedback), before)

    def test_partial_references_do_not_fill_missing_boundaries_or_filter_text_errors(self):
        manifest, feedback = fixture(2)
        feedback["samples"][0]["humanReview"].update(listened=True, spokenText="山录。", startErrorMs=200)
        report = score_review(manifest, feedback, "f" * 64)
        self.assertEqual(report["reviewStatus"], "partial-review")
        self.assertEqual(report["text"]["cer"], 0.5)
        self.assertEqual(report["coverage"]["unknownReferences"], 1)
        self.assertEqual(report["coverage"]["pairedBoundaries"], 0)
        self.assertEqual(report["samples"][0]["humanStartMs"], 800)
        self.assertEqual(report["timing"]["start"]["meanSignedMs"], 200)
        self.assertIsNone(report["timing"]["end"])

    def test_micro_cer_keeps_confirmed_silence_insertions_and_can_exceed_one(self):
        manifest, feedback = fixture(2)
        manifest["samples"][1]["asrText"] = "你。"
        feedback["samples"][0]["humanReview"].update(listened=True, spokenText="")
        feedback["samples"][1]["humanReview"].update(listened=True, spokenText="你")
        report = score_review(manifest, feedback, "f" * 64)
        self.assertEqual(report["text"]["cer"], 2)
        self.assertEqual(report["text"]["emptyReferenceInsertions"], 2)
        self.assertEqual(report["text"]["referenceCharacters"], 1)
        self.assertIsNone(report["samples"][0]["textScore"]["cer"])
        manifest, feedback = fixture()
        feedback["samples"][0]["humanReview"].update(listened=True, spokenText="")
        self.assertIsNone(score_review(manifest, feedback, "f" * 64)["text"]["cer"])

    def test_auto_manual_and_gap_judgements_have_separate_denominators(self):
        manifest, feedback = fixture(3)
        manifest["samples"][1]["selected"]["method"] = "manual"
        manifest["samples"][2].update(selected=None, mappedText=None)
        for index, correct in enumerate((False, True, True)):
            feedback["samples"][index]["humanReview"].update(listened=True, spokenText="山路", mappingCorrect=correct, startErrorMs=0, endErrorMs=-200)
        report = score_review(manifest, feedback, "f" * 64)
        self.assertEqual(report["reviewStatus"], "review-data-complete")
        self.assertEqual(report["acceptance"], "not-evaluated")
        self.assertEqual(report["mapping"]["auto"]["correctFractionAmongReviewed"], 0)
        self.assertEqual(report["mapping"]["manual"]["correctFractionAmongReviewed"], 1)
        self.assertEqual(report["mapping"]["gap"]["correctFractionAmongReviewed"], 1)
        self.assertEqual(report["timing"]["start"]["samples"], 3)
        self.assertEqual(report["timing"]["start"]["meanAbsoluteMs"], 0)
        self.assertEqual(report["samples"][0]["humanEndMs"], 2200)

    def test_casefold_and_nfkc_reuse_existing_evaluation_normalization(self):
        manifest, feedback = fixture()
        manifest["samples"][0]["asrText"] = "Ａß，一！"
        feedback["samples"][0]["humanReview"].update(listened=True, spokenText="ass一")
        result = score_review(manifest, feedback, "f" * 64)
        self.assertEqual(result["text"]["cer"], 0)
        self.assertEqual(result["text"]["referenceCharacters"], 4)

    def test_timing_percentiles_preserve_large_errors_and_the_declared_denominator(self):
        manifest, feedback = fixture(3)
        for entry, delta in zip(feedback["samples"], (200, -100, 0)):
            entry["humanReview"].update(listened=True, startErrorMs=delta)
        summary = score_review(manifest, feedback, "f" * 64)["timing"]["start"]
        self.assertEqual(summary["samples"], 3)
        self.assertEqual(summary["meanAbsoluteMs"], 100)
        self.assertEqual(summary["p50AbsoluteMs"], 100)
        self.assertEqual(summary["p95AbsoluteMs"], 200)

    def test_mismatched_identity_duplicate_missing_and_added_fields_are_rejected(self):
        for change in ("manifest", "id", "time", "hash", "missing", "duplicate", "extra"):
            with self.subTest(change=change):
                manifest, feedback = fixture(2)
                if change == "manifest": feedback["sourceManifestHash"] = "0" * 64
                elif change == "id": feedback["samples"][0]["episodeId"] = "other"
                elif change == "time": feedback["samples"][0]["targetStartMs"] += 1
                elif change == "hash": feedback["samples"][0]["clipHash"] = "0" * 64
                elif change == "missing": feedback["samples"].pop()
                elif change == "duplicate": feedback["samples"][1] = copy.deepcopy(feedback["samples"][0])
                else: feedback["samples"][0]["humanReview"]["passed"] = True
                with self.assertRaises(ValueError): score_review(manifest, feedback, "f" * 64)

    def test_unlistened_nonfinite_silence_and_out_of_clip_boundaries_are_rejected(self):
        for fields in (
            {"spokenText": "山路"}, {"listened": True, "startErrorMs": float("nan")},
            {"listened": True, "startErrorMs": True}, {"listened": True, "startErrorMs": 10 ** 1000},
            {"listened": True, "startErrorMs": 1001},
            {"listened": True, "startErrorMs": -1500, "endErrorMs": 0},
            {"listened": True, "spokenText": "", "startErrorMs": 0},
            {"listened": True, "spokenText": "！？"},
        ):
            with self.subTest(fields=fields):
                manifest, feedback = fixture()
                feedback["samples"][0]["humanReview"].update(fields)
                with self.assertRaises(ValueError): score_review(manifest, feedback, "f" * 64)

    def test_strict_json_rejects_duplicate_keys_nonfinite_values_and_oversize(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "review.json"
            for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b" " * (4 * 1024 * 1024 + 1)):
                path.write_bytes(raw)
                with self.assertRaises(ValueError): strict_json(path)
            path.write_bytes(b'\xef\xbb\xbf{"a":1}')
            self.assertEqual(strict_json(path)[0], {"a": 1})

    def test_clip_bytes_format_duration_and_safe_pack_paths_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            manifest, _ = fixture()
            clips = Path(root) / "clips"
            clips.mkdir()
            path = clips / "episode-1-0.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\0" * 96000)
            manifest["samples"][0]["clipHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest["samples"][0]["clipPath"] = "Z:/ignored-absolute-path.wav"
            self.assertEqual(verify_clips(root, manifest)[0]["durationMs"], 3000)
            manifest["samples"][0]["clipEndMs"] += 10
            with self.assertRaises(ValueError): verify_clips(root, manifest)
            manifest["samples"][0]["clipEndMs"] -= 10
            path.write_bytes(path.read_bytes()[:-2])
            with self.assertRaisesRegex(ValueError, "hash mismatch"): verify_clips(root, manifest)
            manifest["samples"][0]["clipHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "truncated"): verify_clips(root, manifest)
            with wave.open(str(path), "wb") as wav:
                wav.setparams((2, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\0" * 192000)
            manifest["samples"][0]["clipHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "mono PCM16"): verify_clips(root, manifest)
            manifest["samples"][0]["id"] = "../escape"
            with self.assertRaises(ValueError): verify_clips(root, manifest)

    def test_cli_invalid_feedback_has_no_metrics_and_never_overwrites_output(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            manifest, feedback = fixture()
            source = root / "manifest.json"
            review = root / "review.json"
            source.write_text(json.dumps(manifest), encoding="utf-8")
            review.write_text(json.dumps(feedback), encoding="utf-8")
            output = root / "output"
            args = ["--manifest", str(source), "--review", str(review), "--output", str(output)]
            stdout, stderr = StringIO(), StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(main(args), 1)
            self.assertEqual(json.loads(stdout.getvalue())["validation"], "invalid")
            report = json.loads((output / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["validation"], "invalid")
            self.assertNotIn("result", report)
            before = (output / "report.json").read_bytes()
            with redirect_stdout(StringIO()), redirect_stderr(stderr):
                self.assertEqual(main(args), 1)
            self.assertEqual(json.loads(stderr.getvalue())["validation"], "failed")
            self.assertEqual((output / "report.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
