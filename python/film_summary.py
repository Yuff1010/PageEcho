"""Recompute film-clip CER from pinned manual text and actual worker checkpoints."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

from asr_metrics import character_error_rate, normalize_text
from chsims_reference import load_film_manifest
from continuous_summary import reconstructed_documents
from public_reference import digest
from reference_summary import aggregate, error_operations


def summarize(path):
    path = Path(path).resolve()
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("status") not in ("passed", "failed") or report.get("referenceKind") != "human-film-text":
        raise ValueError("A terminal film application-worker report is required")
    if digest(path.parent / "runner-started.ts") != report.get("runnerSha256"):
        raise ValueError("Started worker entry changed")
    manifest_path = Path(report["manifestPath"])
    manifest = load_film_manifest(manifest_path)
    if digest(manifest_path) != report.get("manifestSha256"):
        raise ValueError("Film manifest changed after inference")
    component = json.loads((path.parent / "component.json").read_text(encoding="utf-8"))
    if not isinstance(component.get("cache"), str) or not Path(component["cache"]).is_absolute():
        raise ValueError("The recorded diagnostic component must identify its actual cache root")
    expected = {sample["id"]: sample for sample in manifest["samples"]}
    measured = report["samples"]
    if len(measured) != len(expected) or {sample["id"] for sample in measured} != set(expected):
        raise ValueError("Report omits or duplicates a selected film clip")
    states, scores = [], []
    for sample in measured:
        reference = expected[sample["id"]]
        if sample.get("audioHash") != reference["audioHash"] or sample.get("sourceVideo") != reference["sourceVideo"]:
            raise ValueError("Worker source version/group differs from the reference")
        state = {"id": reference["id"], "sourceVideo": reference["sourceVideo"], "status": sample["status"], "accuracy": None}
        states.append(state)
        if sample["status"] != "completed":
            state.update(error=sample.get("error"), code=sample.get("code"))
            continue
        if sample["cacheHits"] != 0 or sample["replayCacheHits"] != sample["totalChunks"] or sample["durationMs"] != reference["durationMs"]:
            raise ValueError("Missing fresh-run or checkpoint replay evidence")
        document, _ = reconstructed_documents(path.parent, report, sample, reference, checkpoint_root=component["cache"])
        human = "".join(item["text"] for item in reference["reference"])
        hypothesis = "".join(item["text"] for item in document["segments"])
        if not normalize_text(human):
            state["unscoredReason"] = "empty published reference; not assumed to be confirmed silence"
        else:
            state["accuracy"] = character_error_rate(human, hypothesis)
            state["errorOperations"] = error_operations(human, hypothesis)
            scores.append(state)
        state.update(generationMs=sample["generationMs"], firstReadablePartialMs=sample["firstReadablePartialMs"],
                     chunks=sample["totalChunks"], issueCounts=dict(Counter(issue["code"] for issue in sample["issues"])),
                     transcriptSha256=digest(path.parent / sample["transcript"]))
    if all(sample["status"] == "completed" for sample in measured) and report.get("restartCheckpointReused") is not True:
        raise ValueError("Whole cohort lacks worker-restart reuse evidence")
    result = {"report": str(path), "reportSha256": digest(path), "manifestSha256": digest(manifest_path),
              "engine": report["engine"], "device": report["device"], "executionStatus": report["status"],
              "referenceKind": "human-film-text", **aggregate(scores, len(expected)),
              "completedSamples": sum(sample["status"] == "completed" for sample in measured),
              "perSourceVideo": {}, "samples": states}
    for video in sorted({sample["sourceVideo"] for sample in manifest["samples"]}):
        result["perSourceVideo"][video] = aggregate([state for state in scores if state["sourceVideo"] == video],
                                                   sum(sample["sourceVideo"] == video for sample in manifest["samples"]))
    result["errorOperations"] = {key: sum(state["errorOperations"][key] for state in scores) for key in ("substitutions", "deletions", "insertions")}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    target = Path(args.output).resolve()
    if target.exists():
        raise ValueError("Existing film summary must not be overwritten")
    runs = [summarize(path) for path in args.reports]
    if len({run["manifestSha256"] for run in runs}) != 1:
        raise ValueError("Compared runs use different fixed cohorts")
    if len({(run["engine"], run["device"]) for run in runs}) != len(runs):
        raise ValueError("Duplicate engine/device result")
    result = {"status": "summarized", "createdAt": datetime.now(timezone.utc).isoformat(),
              "scoringSourcesSha256": {name: digest(Path(__file__).with_name(name)) for name in ("film_summary.py", "chsims_reference.py", "chsims_sources.json", "asr_metrics.py", "asr_segments.py", "continuous_summary.py", "reference_summary.py")},
              "scope": "Fixed 18 official CH-SIMS test clips, ten source-video IDs; publisher manual text and complete unchanged source audio. No music labels, speaker identity, phonetic times, whole-dataset/audiobook/default-engine acceptance. Model training overlap unknown.",
              "runs": runs}
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as output:
        output.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": "summarized", "runs": len(runs), "output": str(target)}), flush=True)


if __name__ == "__main__":
    main()
