"""Invented checkpoints exercise failure denominators and cache ownership."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from asr_segments import fingerprint, partial_document, windows
from asr_jobs import assembled_document
from continuous_summary import reconstructed_documents
import film_summary as film


class FilmSummaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.external_cache = self.root / "external"
        self.sample = {"id": "first", "audioHash": "a" * 64, "sourceVideo": "video_0001", "durationMs": 1000,
                       "reference": [{"id": "first", "text": "甲乙"}]}
        self.other = {**self.sample, "id": "second"}
        self.configuration = {"chunkMs": 30000, "overlapMs": 2000}
        ownership = {"audioHash": self.sample["audioHash"], "configuration": self.configuration, "startMs": 0, "endMs": 1000}
        self.key = fingerprint(ownership)
        group = self.external_cache / "jobs" / self.key
        group.mkdir(parents=True)
        (group / "manifest.json").write_text(json.dumps({"version": 1, **ownership}), encoding="utf-8")
        units = [{"text": "甲", "startMs": 100, "endMs": 200}]
        self.checkpoint = group / "chunk-000000.json"
        self.checkpoint.write_text(json.dumps({"cacheKey": self.key, "window": next(windows(0, 1000)), "contextUnits": units, "units": units, "issues": []}), encoding="utf-8")
        self.document = partial_document(self.sample["audioHash"], 0, 1000, units)
        (self.root / "first.json").write_text(json.dumps(self.document), encoding="utf-8")
        measured = {**{key: self.sample[key] for key in ("id", "audioHash", "sourceVideo", "durationMs")}, "status": "completed", "cacheKey": self.key,
                    "cacheHits": 0, "replayCacheHits": 1, "totalChunks": 1, "issues": [], "transcript": "first.json", "generationMs": 10, "firstReadablePartialMs": 9}
        runner = self.root / "runner-started.ts"
        runner.write_text("invented test runner", encoding="utf-8")
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"samples": [self.sample, self.other]}), encoding="utf-8")
        self.report = {"status": "failed", "referenceKind": "human-film-text", "engine": "whisperx", "device": "cpu", "configuration": self.configuration,
                       "manifestPath": str(manifest), "manifestSha256": film.digest(manifest), "runnerSha256": film.digest(runner), "samples": [measured,
                       {"id": "second", "audioHash": self.other["audioHash"], "sourceVideo": self.other["sourceVideo"], "status": "failed", "code": "ALIGNMENT_FAILED", "error": "invented failure"}]}
        self.path = self.root / "report.json"
        self.component = {"version": 1, "cache": str(self.external_cache),
                          "python": "recorded-python.exe", "models": "recorded-models.json",
                          "ffmpeg": "recorded-ffmpeg.exe", "ffprobe": "recorded-ffprobe.exe"}
        self.save_component()
        mocked = patch.object(film, "load_film_manifest", return_value={"samples": [self.sample, self.other]})
        mocked.start()
        self.addCleanup(mocked.stop)

    def summarize(self):
        self.path.write_text(json.dumps(self.report), encoding="utf-8")
        return film.summarize(self.path)

    def save_component(self):
        (self.root / 'component.json').write_text(json.dumps(self.component), encoding='utf-8')

    def test_failed_clip_remains_in_denominator_and_corpus_score_is_unavailable(self):
        summary = self.summarize()
        self.assertEqual((summary["completedSamples"], summary["expectedSamples"]), (1, 2))
        self.assertEqual(summary["completedOnlyCER"], 0.5)
        self.assertIsNone(summary["corpusCER"])
        self.assertEqual(summary["samples"][1]["code"], "ALIGNMENT_FAILED")
        self.assertIsNone(summary["samples"][1]["accuracy"])

    def test_omitted_or_duplicate_clip_is_rejected(self):
        original = self.report["samples"]
        for changed in (original[:1], [original[0], original[0]]):
            with self.subTest(changed=changed):
                self.report["samples"] = changed
                with self.assertRaisesRegex(ValueError, "omits or duplicates"):
                    self.summarize()

    def test_changed_raw_context_is_rejected_even_when_saved_transcript_is_valid(self):
        checkpoint = json.loads(self.checkpoint.read_text(encoding="utf-8"))
        checkpoint["contextUnits"][0]["text"] = "丙"
        self.checkpoint.write_text(json.dumps(checkpoint), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "context or ownership"):
            self.summarize()

    def test_external_cache_is_explicit_and_default_run_local_cache_still_works(self):
        measured = self.report["samples"][0]
        actual, _ = reconstructed_documents(self.root, self.report, measured, self.sample, checkpoint_root=self.external_cache)
        self.assertEqual(actual, self.document)
        with self.assertRaises(FileNotFoundError):
            reconstructed_documents(self.root, self.report, measured, self.sample)
        local = self.root / "cache" / "asr"
        local.parent.mkdir()
        self.external_cache.rename(local)
        actual, _ = reconstructed_documents(self.root, self.report, measured, self.sample)
        self.assertEqual(actual, self.document)

    def test_v2_summary_uses_settings_owned_local_cache_and_still_reconstructs_native_checkpoints(self):
        local = self.root / 'cache' / 'asr'
        local.parent.mkdir()
        self.external_cache.rename(local)
        self.component = {key: value for key, value in self.component.items() if key != 'cache'}
        self.component.update(version=2, resources='recorded-resources')
        self.save_component()
        self.report['cache'] = 'untrusted-report-cache-is-ignored'
        self.assertEqual(film.recorded_cache_root(self.root), local.resolve())
        self.assertEqual(self.summarize()['completedOnlyCER'], 0.5)
        checkpoint = local / 'jobs' / self.key / 'chunk-000000.json'
        value = json.loads(checkpoint.read_text(encoding='utf-8'))
        value['contextUnits'][0]['text'] = '丙'
        checkpoint.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'context or ownership'):
            self.summarize()

    def test_missing_or_malformed_cache_configuration_is_rejected_without_fallback_or_writes(self):
        original = self.component
        for changed in ({'cache': str(self.external_cache)}, {**original, 'version': 3},
                        {**original, 'cache': 'relative-cache'},
                        {**original, 'version': 2, 'resources': 'recorded-resources'},
                        {key: value for key, value in original.items() if key != 'python'}):
            self.component = changed
            self.save_component()
            with self.subTest(component=changed), self.assertRaises(ValueError):
                film.recorded_cache_root(self.root)
        self.component = {key: value for key, value in original.items() if key != 'cache'}
        self.component.update(version=2, resources='recorded-resources')
        self.save_component()
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            film.recorded_cache_root(self.root)
        self.assertFalse((self.root / 'cache').exists())

    def test_current_stable_ids_are_reconstructed_from_checkpoints_and_unknown_saved_ids_are_rejected(self):
        plan = list(windows(0, self.sample['durationMs']))
        checkpoint = json.loads(self.checkpoint.read_text(encoding='utf-8'))
        current, _, issues = assembled_document(self.sample['audioHash'], plan, {0: checkpoint}, 2000)
        self.assertEqual(issues, [])
        self.assertNotEqual(current['segments'][0]['id'], self.document['segments'][0]['id'])
        saved = self.root / 'first.json'
        saved.write_text(json.dumps(current), encoding='utf-8')
        self.assertEqual(self.summarize()['completedOnlyCER'], 0.5)
        current['segments'][0]['id'] = 'asr-100-unknown-content-identity'
        saved.write_text(json.dumps(current), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Reconstructed document'):
            self.summarize()


if __name__ == "__main__":
    unittest.main()
