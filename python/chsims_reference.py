"""Pinned CH-SIMS test film/TV/variety clips; published human text, no phonetic times."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import wave

from asr_metrics import normalize_text

SELECTION = "First 10 lexically sorted source-video IDs present in official test split; up to first 2 clip IDs per video, numeric order. No text, duration, sentiment, background or ASR-result filtering."
REFERENCE_KIND = "human-film-text"
SOURCES = Path(__file__).with_name("chsims_sources.json")


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def choose_rows(payload):
    rows = list(csv.reader(io.StringIO(payload.decode("utf-8-sig"))))
    grouped, seen = {}, set()
    for index, row in enumerate(rows):
        if (len(row) != 9 or not re.fullmatch(r"video_[0-9]{4}", row[0]) or
                not re.fullmatch(r"[0-9]{4}", row[1]) or row[-1] not in ("train", "valid", "test")):
            raise ValueError("Unexpected original CH-SIMS label row")
        identity = (row[0], row[1])
        if identity in seen:
            raise ValueError("Duplicate CH-SIMS source identity")
        seen.add(identity)
        if row[-1] == "test":
            grouped.setdefault(row[0], []).append((index, row))
    chosen = []
    for video in sorted(grouped)[:10]:
        for index, row in sorted(grouped[video], key=lambda item: int(item[1][1]))[:2]:
            chosen.append({"rowIndex": index, "videoId": row[0], "clipId": row[1], "text": row[2], "split": row[-1]})
    return chosen


def expected_reference(row):
    identity = f"chsims-{row['videoId']}-{row['clipId']}"
    return {"id": identity, "sourceVideo": row["videoId"], "sourceClip": row["clipId"],
            "sourceRowIndex": row["rowIndex"], "split": row["split"], "offsetMs": 0,
            "reference": [{"id": identity, "text": row["text"]}],
            "referenceType": "publisher manual Chinese transcript of complete source clip; no phonetic timestamps"}


def verify_sources(root):
    root = Path(root).resolve()
    pins = json.loads(SOURCES.read_text(encoding="utf-8"))
    label = root / "label.csv"
    if label.stat().st_size != pins["label"]["bytes"] or digest(label) != pins["label"]["sha256"]:
        raise ValueError("Publisher label CSV changed")
    rows = choose_rows(label.read_bytes())
    if len(rows) != 18 or {f"{row['videoId']}/{row['clipId']}" for row in rows} != set(pins["files"]):
        raise ValueError("Pinned source selection changed")
    for row in rows:
        pin = pins["files"][f"{row['videoId']}/{row['clipId']}"]
        original = root / "original" / row["videoId"] / f"{row['clipId']}.mp4"
        if original.stat().st_size != pin["bytes"] or digest(original) != pin["sha256"]:
            raise ValueError("Publisher original media changed or is missing")
    return rows, pins


def run(command):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run([str(item) for item in command], capture_output=True, timeout=30, check=True, **options)
    if len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError("Unexpectedly large decoded source")
    return result.stdout


def decode(ffmpeg, path):
    return run([ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"])


def inspect_wav(path):
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("Unexpected derived PCM format")
        frames = audio.getnframes()
        pcm = audio.readframes(frames)
        if frames * 2 != len(pcm) or not 0 < frames <= 30 * 16000:
            raise ValueError("Truncated or unexpectedly long film audio")
        return pcm, frames


def load_film_manifest(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("referenceKind") != REFERENCE_KIND or manifest.get("selection") != SELECTION:
        raise ValueError("Unexpected CH-SIMS reference contract")
    if manifest["source"].get("pinsSha256") != digest(SOURCES):
        raise ValueError("CH-SIMS source pins changed")
    rows, pins = verify_sources(manifest["source"]["sourceRoot"])
    tools = manifest["tools"]
    for name in ("ffmpeg", "ffprobe"):
        if digest(tools[name]["path"]) != tools[name]["sha256"]:
            raise ValueError("Film preparation tool changed")
    if len(manifest["samples"]) != len(rows):
        raise ValueError("Film manifest omits a selected clip")
    for sample, row in zip(manifest["samples"], rows):
        expected = expected_reference(row)
        if any(sample.get(key) != value for key, value in expected.items()):
            raise ValueError("Film human text, identity, order or selection changed")
        pin = pins["files"][f"{row['videoId']}/{row['clipId']}"]
        original = Path(manifest["source"]["sourceRoot"]).resolve() / "original" / row["videoId"] / f"{row['clipId']}.mp4"
        target = path.parent / "pcm16" / f"{expected['id']}.wav"
        if Path(sample["sourcePath"]).resolve() != original or sample.get("sourceSha256") != pin["sha256"] or sample.get("sourceDriveId") != pin["driveId"]:
            raise ValueError("Film source identity changed")
        if Path(sample["path"]).resolve() != target or digest(target) != sample["audioHash"]:
            raise ValueError("Film derived media changed")
        pcm, frames = inspect_wav(target)
        if pcm != decode(tools["ffmpeg"]["path"], original) or frames != sample["frames"] or round(frames / 16) != sample["durationMs"]:
            raise ValueError("Film audio is not the complete unchanged resample")
    return manifest


def prepare(source_root, output, ffmpeg, ffprobe):
    source_root, output = Path(source_root).resolve(), Path(output).resolve()
    if output.exists():
        return load_film_manifest(output / "manifest.json")
    rows, pins = verify_sources(source_root)
    output.mkdir(parents=True, exist_ok=False)
    (output / "pcm16").mkdir()
    samples = []
    for row in rows:
        expected = expected_reference(row)
        original = source_root / "original" / row["videoId"] / f"{row['clipId']}.mp4"
        target = output / "pcm16" / f"{expected['id']}.wav"
        pcm = decode(ffmpeg, original)
        with wave.open(str(target), "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(pcm)
        _, frames = inspect_wav(target)
        pin = pins["files"][f"{row['videoId']}/{row['clipId']}"]
        source_probe = json.loads(run([ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,sample_rate,channels,duration", "-of", "json", original]))
        samples.append({**expected, "sourcePath": str(original), "sourceSha256": pin["sha256"], "sourceDriveId": pin["driveId"],
                        "sourceProbe": source_probe, "path": str(target), "audioHash": digest(target),
                        "frames": frames, "durationMs": round(frames / 16)})
    manifest = {"version": 1, "referenceKind": REFERENCE_KIND, "preparedAt": datetime.now(timezone.utc).isoformat(),
                "selection": SELECTION, "source": {"dataset": "CH-SIMS original, official test split",
                "sourceRoot": str(source_root), "labelSha256": pins["label"]["sha256"], "pinsSha256": digest(SOURCES),
                "labelDriveId": pins["label"]["driveId"], "driveFolder": "https://drive.google.com/drive/folders/1oplJ15kdS_OK0wHXycI8p77jnmwAHhbG",
                "publisherPage": "https://thuiar.github.io/sims.github.io/chsims", "paper": "https://aclanthology.org/2020.acl-main.343.pdf"},
                "tools": {name: {"path": str(Path(value).resolve()), "sha256": digest(value)} for name, value in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe))},
                "qualityScope": "Complete isolated film/TV/variety clips with publisher manual text. No per-clip music labels, speaker identity, conversation continuity or phonetic boundaries. Training overlap unknown; local diagnostic assets excluded from application distribution.",
                "samples": samples}
    target = output / "manifest.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return load_film_manifest(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--output", default="cache/asr-evaluation/public-reference/chsims-film")
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    args = parser.parse_args()
    manifest = prepare(args.source_root, args.output, str(Path(args.ffmpeg).resolve()), str(Path(args.ffprobe).resolve()))
    print(json.dumps({"status": "verified", "manifest": str(Path(args.output).resolve() / "manifest.json"), "samples": len(manifest["samples"]), "sourceVideos": len({row["sourceVideo"] for row in manifest["samples"]}), "referenceCharacters": sum(len(normalize_text(row["reference"][0]["text"])) for row in manifest["samples"]), "durationMs": sum(row["durationMs"] for row in manifest["samples"])}), flush=True)


if __name__ == "__main__":
    main()
