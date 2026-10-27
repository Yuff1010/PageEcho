"""Invented rows only; no network, media download, model or real labels."""

import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

import chsims_reference as film
from chsims_reference import choose_rows, expected_reference


def payload(rows):
    target = io.StringIO()
    csv.writer(target).writerows(rows)
    return target.getvalue().encode("utf-8")


def row(video, clip, text="虚构测试文字", split="test"):
    return [f"video_{video:04d}", f"{clip:04d}", text, "0", "0", "0", "0", "Neutral", split]


class FilmReferenceTests(unittest.TestCase):
    def test_selection_uses_test_video_clip_order_not_text_or_sentiment(self):
        rows = [row(1, 1, split="train"), row(2, 8, "更长的字串"), row(1, 7, ""), row(2, 1, "一"), row(1, 2, "啊"), row(1, 9)]
        result = choose_rows(payload(rows))
        self.assertEqual([(item["videoId"], item["clipId"]) for item in result], [("video_0001", "0002"), ("video_0001", "0007"), ("video_0002", "0001"), ("video_0002", "0008")])
        self.assertEqual([item["text"] for item in result], ["啊", "", "一", "更长的字串"])
        self.assertEqual(result[0]["rowIndex"], 4)

    def test_fewer_than_two_clips_are_kept_and_only_first_ten_video_ids_are_used(self):
        rows = [row(video, 3) for video in range(12, 0, -1)]
        chosen = choose_rows(payload(rows))
        self.assertEqual(len(chosen), 10)
        self.assertEqual(chosen[-1]["videoId"], "video_0010")

    def test_csv_quoting_and_original_text_are_preserved(self):
        text = '虚构，with,comma 和"引号"。'
        value = choose_rows(payload([row(1, 1, text)]))[0]
        reference = expected_reference(value)
        self.assertEqual(reference["reference"][0]["text"], text)
        self.assertNotIn("startMs", reference["reference"][0])
        self.assertNotIn("speaker", reference)

    def test_duplicate_malformed_path_and_split_are_rejected(self):
        invalid = [payload([row(1, 1), row(1, 1)]), payload([row(1, 1)[:-1]])]
        for column, value in ((0, "../elsewhere"), (1, "0001/other"), (8, "unknown")):
            current = row(1, 1)
            current[column] = value
            invalid.append(payload([current]))
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(ValueError):
                choose_rows(source)


class FilmMediaIntegrityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        rows = [row(video, clip) for video in range(1, 11) for clip in range(1, 3 if video < 9 else 2)]
        label = self.source / "label.csv"
        label.write_bytes(payload(rows))
        pins = {"label": {"bytes": label.stat().st_size, "sha256": film.digest(label), "driveId": "invented-label"}, "files": {}}
        for selected in choose_rows(label.read_bytes()):
            identity = f"{selected['videoId']}/{selected['clipId']}"
            original = self.source / "original" / selected["videoId"] / f"{selected['clipId']}.mp4"
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_bytes(identity.encode())
            pins["files"][identity] = {"bytes": original.stat().st_size, "sha256": film.digest(original), "driveId": f"invented-{identity}"}
        pin_path = self.root / "pins.json"
        pin_path.write_text(json.dumps(pins), encoding="utf-8")
        for name in ("ffmpeg", "ffprobe"):
            (self.root / name).write_bytes(name.encode())
        for name, value in (("SOURCES", pin_path), ("decode", None), ("run", None)):
            mock = patch.object(film, name, value) if value is not None else patch.object(film, name)
            replacement = mock.start()
            self.addCleanup(mock.stop)
            if name == "decode":
                replacement.return_value = b"\x01\x00" * 1600
            elif name == "run":
                replacement.return_value = b'{"streams": []}'
        self.output = self.root / "prepared"
        self.manifest = film.prepare(self.source, self.output, self.root / "ffmpeg", self.root / "ffprobe")
        self.path = self.output / "manifest.json"

    def save(self):
        self.path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_complete_resampling_and_existing_manifest_are_verified(self):
        verified = film.load_film_manifest(self.path)
        self.assertEqual(len(verified["samples"]), 18)
        self.assertEqual(verified["samples"][0]["durationMs"], 100)
        self.assertEqual(film.prepare(self.source, self.output, None, None), verified)

    def test_text_order_identity_and_duration_cannot_be_relabelled(self):
        original = self.path.read_text(encoding="utf-8")
        for key, value in (("reference", [{"id": "invented", "text": "替换"}]), ("sourceDriveId", "other"), ("durationMs", 99), ("frames", 1599)):
            with self.subTest(key=key):
                self.manifest = json.loads(original)
                self.manifest["samples"][0][key] = value
                self.save()
                with self.assertRaises(ValueError):
                    film.load_film_manifest(self.path)
        self.manifest = json.loads(original)
        self.manifest["samples"].reverse()
        self.save()
        with self.assertRaises(ValueError):
            film.load_film_manifest(self.path)

    def test_rehashed_but_edited_pcm_is_rejected_against_original_decode(self):
        sample = self.manifest["samples"][0]
        with wave.open(sample["path"], "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\x02\x00" * 1600)
        sample["audioHash"] = film.digest(sample["path"])
        self.save()
        with self.assertRaisesRegex(ValueError, "complete unchanged"):
            film.load_film_manifest(self.path)

    def test_changed_publisher_bytes_or_tool_fail_before_scoring(self):
        for target in (self.source / "label.csv", Path(self.manifest["samples"][0]["sourcePath"]), self.root / "ffmpeg"):
            with self.subTest(target=target):
                original = target.read_bytes()
                target.write_bytes(original + b"changed")
                with self.assertRaises(ValueError):
                    film.load_film_manifest(self.path)
                target.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
