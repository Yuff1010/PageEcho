"""Audit existing frozen Chinese-reference runs and export a small UI evidence snapshot.

No model is loaded. Original media, reports, references, and checkpoints are never written.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
from asr_metrics import character_error_rate, timing_issues  # noqa: E402
from continuous_summary import reconstructed_documents  # noqa: E402


SOURCES = (
    ("studio", "studio-source-discovery/summary-final.json", "540290506b2558dc4469123cbe8996d60c9f3e079c35d376c6977825000c16fd", None),
    ("continuous", "continuous-reference-summary-final.json", "3a3e86590d42a473b630253d3a883b1473127463ac25ab1a7f075dc1178a73b4", None),
    ("film", "film-summary-four-groups.json", "1de9b02ddd5a766f0376261cdbbd78210680ed2f339338e004ea9c56331fb957", "paraformer"),
    ("film", "film-summary-bounded-whisper.json", "ea0fe274c7ce86c5417d3216ac54d4738122160ddcb0091be96483b6da0d5812", "whisperx"),
)
DATASETS = {
    "studio": {
        "label": "真人干声短句", "source": "AISHELL-3", "samples": 40,
        "referenceCharacters": 267, "durationMs": 123689,
        "manifestSha256": "19aaef24050a90c948b3ca9444bb57fc33d0e1c90049c089168ca9f4767a9f51",
        "scope": "两位说话人的短词、短句及数字；数字写法差异保留为编辑错误。",
    },
    "continuous": {
        "label": "连续会议语音", "source": "AISHELL-4", "samples": 3,
        "referenceCharacters": 1012, "durationMs": 288422,
        "manifestSha256": "83e892faf6b4c426ad4ddde0211451bdf5eacbb1eb62c9b94468215f2be10896",
        "scope": "同一场会议中的三段连续单人及轮流对话，包含分块切口。",
    },
    "film": {
        "label": "影视短对白", "source": "CH-SIMS", "samples": 18,
        "referenceCharacters": 244, "durationMs": 55425,
        "manifestSha256": "1462a41e250bd63756e2dc56e7d9e61744b647185c5be2c3dd59d18367c8e778",
        "scope": "官方 test 中固定十个源视频组；WhisperX 使用末端修复后的完整集合。",
    },
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def relative(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def build_snapshot():
    base = ROOT / "cache/asr-evaluation"
    datasets = {key: {"id": key, **value, "summaries": [], "profiles": []} for key, value in DATASETS.items()}
    verified_documents, verified_checkpoints = [], []
    checked_audio = set()
    for kind, summary_file, expected_hash, selected_engine in SOURCES:
        summary_path = base / summary_file
        require(digest(summary_path) == expected_hash, f"Frozen summary changed: {summary_file}")
        summary = read(summary_path)
        require(summary.get("status") == "summarized", "Summary is not complete")
        dataset = datasets[kind]
        dataset["summaries"].append({"path": relative(summary_path), "sha256": expected_hash})
        for row in summary["runs"]:
            if selected_engine and row["engine"] != selected_engine:
                continue
            require(row["executionStatus"] == "passed", "Failed cohorts cannot become a complete quality reference")
            report_path = Path(row["report"])
            require(digest(report_path) == row["reportSha256"], "Native report changed")
            report = read(report_path)
            require(report["status"] == "passed", "Native run failed")
            manifest_path = Path(report["manifestPath"])
            require(digest(manifest_path) == report["manifestSha256"] == dataset["manifestSha256"], "Fixed manual reference changed")
            manifest = read(manifest_path)
            expected = {sample["id"]: sample for sample in manifest["samples"]}
            require(len(expected) == len(manifest["samples"]) == len(report["samples"]) == dataset["samples"], "Incomplete or duplicate cohort")
            checkpoint_root = report_path.parent / "cache/asr"
            if kind == "film":
                checkpoint_root = Path(read(report_path.parent / "component.json")["cache"])
            edits = characters = duration = 0
            documents, checkpoints = [], []
            for measured in report["samples"]:
                require(measured["id"] in expected, "Duplicate or unknown measured sample")
                sample = expected.pop(measured["id"])
                require(measured["status"] == "completed" and measured["cacheHits"] == 0, "First run is incomplete or reused")
                require(measured["replayCacheHits"] == measured["totalChunks"], "Missing checkpoint replay evidence")
                require(measured["durationMs"] == sample["durationMs"], "Media duration changed")
                if sample["audioHash"] not in checked_audio:
                    require(digest(sample["path"]) == sample["audioHash"], "Reference PCM changed")
                    checked_audio.add(sample["audioHash"])
                document, _ = reconstructed_documents(report_path.parent, report, measured, sample, checkpoint_root=checkpoint_root)
                require(document["audioHash"] == measured["audioHash"] == sample["audioHash"], "Worker media identity changed")
                require(not timing_issues(document["segments"], sample["durationMs"]), "Invalid worker times")
                score = character_error_rate("".join(item["text"] for item in sample["reference"]), "".join(item["text"] for item in document["segments"]))
                edits += score["editDistance"]
                characters += score["referenceCharacters"]
                duration += sample["durationMs"]
                path = report_path.parent / measured["transcript"]
                documents.append({"id": sample["id"], "path": relative(path), "sha256": digest(path)})
                group = checkpoint_root / "jobs" / measured["cacheKey"]
                for path in [group / "manifest.json", *sorted(group.glob("chunk-*.json"))]:
                    checkpoints.append({"path": relative(path), "sha256": digest(path)})
            require(not expected and report.get("restartCheckpointReused") is True, "Incomplete set or missing worker restart replay")
            scores = row["actual"] if kind == "continuous" else row
            require(scores["editDistance"] == edits and characters == dataset["referenceCharacters"], "Recomputed edit counts differ")
            require(duration == dataset["durationMs"] and abs(scores["corpusCER"] - edits / characters) < 1e-12, "Recomputed whole-cohort CER differs")
            profile = {
                "engine": row["engine"], "device": row["device"], "completedSamples": dataset["samples"],
                "editDistance": edits, "cer": edits / characters,
                "report": relative(report_path), "reportSha256": row["reportSha256"],
                "documentsSha256": canonical_hash(documents), "checkpointsSha256": canonical_hash(checkpoints),
            }
            require(not any(other["engine"] == profile["engine"] and other["device"] == profile["device"] for other in dataset["profiles"]), "Duplicate engine/device cohort")
            dataset["profiles"].append(profile)
            verified_documents.extend(documents)
            verified_checkpoints.extend(checkpoints)
    for dataset in datasets.values():
        require({(row["engine"], row["device"]) for row in dataset["profiles"]} == {(engine, device) for engine in ("whisperx", "paraformer") for device in ("cpu", "cuda")}, "Missing engine/device comparison")
        dataset["profiles"].sort(key=lambda row: (row["device"], row["engine"]))
    snapshot = {
        "schemaVersion": 1,
        "evidenceDate": "2026-10-21",
        "status": "provisional-reference",
        "normalization": "NFKC, casefold, letters and numbers only; no number or traditional/simplified conversion",
        "suggestedTrialEngine": "paraformer",
        "automaticSelection": False,
        "novelQualityAcceptance": "pending-human-review",
        "scope": "Fixed published manual Chinese-reference subsets only; no book accuracy, human timing, official corpus or default-engine acceptance. Training overlap unknown.",
        "datasets": list(datasets.values()),
    }
    return snapshot, {"documents": verified_documents, "checkpoints": verified_checkpoints, "uniqueAudioFiles": len(checked_audio)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "src/shared/engine-reference.json")
    parser.add_argument("--write-snapshot", action="store_true", help="Create a new snapshot; never overwrite an existing one")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    snapshot, inventory = build_snapshot()
    if args.write_snapshot:
        with args.snapshot.open("x", encoding="utf-8") as target:
            target.write(json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    else:
        require(read(args.snapshot) == snapshot, "Shipped reference snapshot differs from audited evidence")
    directory = args.output or ROOT / "cache/asr-evaluation/engine-reference-audits" / datetime.now(timezone.utc).isoformat().replace(":", "-")
    directory.mkdir(parents=True, exist_ok=False)
    audit = {
        "status": "verified-existing-evidence", "auditedAt": datetime.now(timezone.utc).isoformat(),
        "inferenceRuns": 0, "verifiedProfiles": 12, "verifiedSampleResults": len(inventory["documents"]),
        "snapshotSha256": digest(args.snapshot), "snapshotCanonicalSha256": canonical_hash(snapshot),
        "auditScriptSha256": digest(__file__),
        "method": "Frozen summary/report/manifest and PCM hashes; exact cohorts; fresh/replay/restart identity; checkpoint ownership and reconstructed documents; independent whole-cohort CER rescore. No new manual labels or inference.",
        **inventory,
    }
    (directory / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": audit["status"], "profiles": audit["verifiedProfiles"], "sampleResults": audit["verifiedSampleResults"], "output": str(directory)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
