"""Validate listening feedback against a frozen pack; never infer human labels."""

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
import wave

from asr_metrics import character_error_rate, normalize_text


ANCHORS = ("id", "episodeId", "audioHash", "originalHash", "clipHash", "targetStartMs", "targetEndMs")
HUMAN_KEYS = ("listened", "spokenText", "mappingCorrect", "startErrorMs", "endErrorMs", "notes")
MAX_JSON_BYTES = 4 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def keys(value, expected, message):
    require(isinstance(value, dict) and set(value) == set(expected), message)


def finite(value):
    return type(value) in (int, float) and -60000 <= value <= 60000 and math.isfinite(value)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def read_limited(path, limit):
    with Path(path).open("rb") as source:
        raw = source.read(limit + 1)
    require(len(raw) <= limit, f"Input exceeds {limit} bytes")
    return raw


def strict_json(path):
    raw = read_limited(path, MAX_JSON_BYTES)

    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, f"Duplicate JSON key: {key}")
            value[key] = item
        return value

    def nonfinite(value):
        raise ValueError(f"Nonfinite JSON number: {value}")

    return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs, parse_constant=nonfinite), raw


def timing_summary(values):
    if not values:
        return None
    absolute = sorted(abs(value) for value in values)
    return {
        "samples": len(values),
        "meanSignedMs": sum(values) / len(values),
        "meanAbsoluteMs": sum(absolute) / len(absolute),
        "p50AbsoluteMs": absolute[min(len(absolute) - 1, math.floor(len(absolute) * 0.5))],
        "p95AbsoluteMs": absolute[min(len(absolute) - 1, math.floor(len(absolute) * 0.95))],
        "maximumAbsoluteMs": absolute[-1],
    }


def score_review(manifest, feedback, manifest_hash):
    """Pure schema/identity checks and statistics; validation is not acceptance."""
    keys(feedback, ("status", "sourceManifestHash", "samples"), "Invalid feedback root fields")
    require(isinstance(feedback["status"], str) and len(feedback["status"]) <= 80, "Invalid declared status")
    require(feedback["sourceManifestHash"] == manifest_hash, "Feedback targets a different manifest")
    require(isinstance(manifest, dict), "Invalid manifest root")
    samples = manifest.get("samples")
    require(isinstance(samples, list) and 0 < len(samples) <= 1000, "Invalid manifest sample count")
    supplied = feedback["samples"]
    require(isinstance(supplied, list) and len(supplied) == len(samples), "Missing or extra feedback samples")
    by_id = {}
    for entry in supplied:
        keys(entry, (*ANCHORS, "humanReview"), "Invalid feedback sample fields")
        identity = entry["id"]
        require(isinstance(identity, str) and identity not in by_id, "Duplicate or invalid feedback ID")
        by_id[identity] = entry
    seen = set()
    rows, starts, ends = [], [], []
    mapping = {kind: {"total": 0, "reviewed": 0, "correct": 0, "incorrect": 0} for kind in ("auto", "manual", "gap")}
    references = errors = reference_characters = hypothesis_characters = empty_references = empty_insertions = 0
    listened = paired = silence = 0
    for sample in samples:
        require(isinstance(sample, dict), "Invalid manifest sample")
        identity = sample.get("id")
        require(isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", identity), "Unsafe manifest sample ID")
        require(identity not in seen and identity in by_id, "Duplicate or unknown manifest sample ID")
        seen.add(identity)
        require(isinstance(sample.get("episodeId"), str) and 0 < len(sample["episodeId"]) <= 128, f"{identity}: invalid episode ID")
        entry = by_id[identity]
        require(all(entry[key] == sample.get(key) for key in ANCHORS), f"{identity}: immutable identity/time mismatch")
        for key in ("audioHash", "originalHash", "clipHash"):
            require(isinstance(sample.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", sample[key]), f"{identity}: invalid {key}")
        times = [sample.get(key) for key in ("clipStartMs", "targetStartMs", "targetEndMs", "clipEndMs")]
        require(all(type(value) is int and 0 <= value <= 36000000000 for value in times), f"{identity}: invalid source coordinates")
        clip_start, target_start, target_end, clip_end = times
        require(clip_start <= target_start < target_end <= clip_end and clip_end - clip_start <= 60000, f"{identity}: invalid clip/target range")
        require(isinstance(sample.get("asrText"), str) and len(sample["asrText"]) <= 10000, f"{identity}: invalid ASR text")
        selected = sample.get("selected")
        kind = "gap"
        if selected is not None:
            keys(selected, ("first", "last", "method"), f"{identity}: invalid selected mapping")
            require(type(selected["first"]) is int and type(selected["last"]) is int and 0 <= selected["first"] <= selected["last"], f"{identity}: invalid original range")
            require(selected["method"] in ("auto", "manual") and isinstance(sample.get("mappedText"), str), f"{identity}: invalid mapping kind/text")
            kind = selected["method"]
        else:
            require(sample.get("mappedText") is None, f"{identity}: gap has mapped text")
        human = entry["humanReview"]
        keys(human, HUMAN_KEYS, f"{identity}: invalid human review fields")
        require(type(human["listened"]) is bool, f"{identity}: listened must be boolean")
        spoken = human["spokenText"]
        require(spoken is None or isinstance(spoken, str) and len(spoken) <= 10000, f"{identity}: invalid spoken text")
        require(spoken is None or spoken == "" or bool(normalize_text(spoken)), f"{identity}: use null for unknown speech, empty string for confirmed no speech")
        require(human["mappingCorrect"] is None or type(human["mappingCorrect"]) is bool, f"{identity}: invalid mapping judgement")
        require(human["notes"] is None or isinstance(human["notes"], str) and len(human["notes"]) <= 4000, f"{identity}: invalid notes")
        for key in ("startErrorMs", "endErrorMs"):
            require(human[key] is None or finite(human[key]), f"{identity}: invalid {key}")
        require(human["listened"] or all(human[key] is None for key in ("spokenText", "mappingCorrect", "startErrorMs", "endErrorMs")), f"{identity}: labels supplied without listened=true")
        require(spoken != "" or human["startErrorMs"] is None and human["endErrorMs"] is None, f"{identity}: confirmed no speech has no phonetic boundaries")
        human_start = None if human["startErrorMs"] is None else target_start - human["startErrorMs"]
        human_end = None if human["endErrorMs"] is None else target_end - human["endErrorMs"]
        for boundary in (human_start, human_end):
            require(boundary is None or clip_start <= boundary <= clip_end, f"{identity}: human boundary is outside the listening clip")
        require(human_start is None or human_end is None or human_start < human_end, f"{identity}: human boundaries are reversed/empty")
        mapping[kind]["total"] += 1
        if human["mappingCorrect"] is not None:
            mapping[kind]["reviewed"] += 1
            mapping[kind]["correct" if human["mappingCorrect"] else "incorrect"] += 1
        text_score = None
        if spoken is not None:
            references += 1
            normalized_reference, normalized_hypothesis = normalize_text(spoken), normalize_text(sample["asrText"])
            if normalized_reference:
                text_score = character_error_rate(spoken, sample["asrText"])
            else:
                empty_references += 1
                empty_insertions += len(normalized_hypothesis)
                text_score = {"referenceCharacters": 0, "hypothesisCharacters": len(normalized_hypothesis), "editDistance": len(normalized_hypothesis), "cer": None}
            reference_characters += text_score["referenceCharacters"]
            hypothesis_characters += text_score["hypothesisCharacters"]
            errors += text_score["editDistance"]
        listened += int(human["listened"])
        silence += int(spoken == "")
        if human_start is not None:
            starts.append(human["startErrorMs"])
        if human_end is not None:
            ends.append(human["endErrorMs"])
        paired += int(human_start is not None and human_end is not None)
        rows.append({
            "id": identity, "episodeId": sample["episodeId"], "selectionKind": kind,
            "humanReview": human, "asrText": sample["asrText"], "mappedText": sample["mappedText"],
            "textScore": text_score, "humanStartMs": human_start, "humanEndMs": human_end,
        })
    for values in mapping.values():
        values["unknown"] = values["total"] - values["reviewed"]
        values["correctFractionAmongReviewed"] = values["correct"] / values["reviewed"] if values["reviewed"] else None
    count = len(samples)
    complete = listened == references == count and sum(item["reviewed"] for item in mapping.values()) == count and paired + silence == count
    return {
        "reviewStatus": "unreviewed" if listened == 0 else "review-data-complete" if complete else "partial-review",
        "declaredReviewStatus": feedback["status"], "acceptance": "not-evaluated",
        "coverage": {"totalSamples": count, "listened": listened, "notListened": count - listened, "referenceSamples": references, "unknownReferences": count - references, "startBoundaries": len(starts), "endBoundaries": len(ends), "pairedBoundaries": paired, "confirmedNoSpeech": silence},
        "text": {"referenceCharacters": reference_characters, "hypothesisCharacters": hypothesis_characters, "editDistance": errors, "cer": errors / reference_characters if reference_characters else None, "emptyReferenceSamples": empty_references, "emptyReferenceInsertions": empty_insertions, "normalization": "NFKC, casefold, letters and numbers only; no number or traditional/simplified conversion"},
        "mapping": mapping,
        "timing": {"start": timing_summary(starts), "end": timing_summary(ends), "sign": "machine boundary minus human boundary; positive means machine late", "percentile": "zero-based floor(n*p), capped to final sorted absolute error; no CER-based filtering"},
        "samples": rows,
        "scope": "Fixed listening excerpts only. Unknown labels remain unknown; metrics do not approve quality, authenticate a reviewer, estimate whole-book accuracy or select an ASR engine.",
    }


def verify_clips(root, manifest):
    root = Path(root).resolve(strict=True)
    verified = []
    for sample in manifest["samples"]:
        identity = sample["id"]
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", identity), "Unsafe clip ID")
        path = (root / "clips" / f"{identity}.wav").resolve(strict=True)
        require(path.is_relative_to(root) and path.is_file(), "Clip resolves outside its pack")
        require(path.stat().st_size <= 2 * 1024 * 1024, f"{identity}: clip exceeds 2 MiB")
        raw = read_limited(path, 2 * 1024 * 1024)
        require(sha256(raw) == sample["clipHash"], f"{identity}: clip hash mismatch")
        with wave.open(io.BytesIO(raw), "rb") as wav:
            require((wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) == (1, 2, 16000, "NONE"), f"{identity}: expected mono PCM16/16kHz")
            duration_ms = wav.getnframes() / wav.getframerate() * 1000
            require(abs(duration_ms - (sample["clipEndMs"] - sample["clipStartMs"])) <= 2, f"{identity}: clip duration mismatch")
            require(len(wav.readframes(wav.getnframes())) == wav.getnframes() * 2, f"{identity}: truncated PCM data")
        verified.append({"id": identity, "path": str(path), "bytes": len(raw), "sha256": sha256(raw), "durationMs": duration_ms})
    return verified


def create_output(explicit=None, base="cache/asr-evaluation/original-review-results"):
    if explicit:
        output = Path(explicit).resolve()
        output.mkdir(parents=True, exist_ok=False)
        return output
    base = Path(base).resolve()
    base.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z").replace(":", "-")
    return Path(tempfile.mkdtemp(prefix=f"{stamp}-", dir=base))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--review", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        output = create_output(args.output)
    except OSError as error:
        print(json.dumps({"validation": "failed", "error": f"New output directory required: {error}"}), file=sys.stderr)
        return 1
    report = {"validation": "running", "startedAt": datetime.now(timezone.utc).isoformat(), "policyVersion": 1, "manifest": str(Path(args.manifest).resolve()), "review": str(Path(args.review).resolve()), "output": str(output)}
    try:
        manifest, manifest_raw = strict_json(args.manifest)
        feedback, feedback_raw = strict_json(args.review)
        # Preserve exact bytes and evaluation code without modifying either input.
        (output / "review-input.json").write_bytes(feedback_raw)
        (output / "manifest-input.json").write_bytes(manifest_raw)
        shutil.copyfile(__file__, output / "runner-started.py")
        shutil.copyfile(Path(__file__).with_name("asr_metrics.py"), output / "metrics-started.py")
        report["inputHashes"] = {"manifest": sha256(manifest_raw), "review": sha256(feedback_raw), "runner": sha256((output / "runner-started.py").read_bytes()), "metrics": sha256((output / "metrics-started.py").read_bytes())}
        result = score_review(manifest, feedback, sha256(manifest_raw))
        clips = verify_clips(Path(args.manifest).parent, manifest)
        require(Path(args.manifest).read_bytes() == manifest_raw and Path(args.review).read_bytes() == feedback_raw, "Input changed during evaluation")
        require(all(sha256(Path(clip["path"]).read_bytes()) == clip["sha256"] for clip in clips), "Clip changed during evaluation")
        report.update({"validation": "valid", "result": result, "clipsVerified": clips, "inputsUnchanged": True})
        coverage = result["coverage"]
        cer = result["text"]["cer"]
        summary = ["# 听审反馈校验与统计", "", f"数据状态：{result['reviewStatus']}；质量验收：未判定。", "", f"已声明试听 {coverage['listened']}/{coverage['totalSamples']}；文字参考 {coverage['referenceSamples']}；完整起止边界 {coverage['pairedBoundaries']}。", f"CER：{'未提供非空人工参考' if cer is None else f'{cer:.2%}'}。", "", "自动映射、人工映射与留空判断分开统计；未判断项不计为正确。时间误差不按文字是否匹配筛选。详见 report.json 的分母、逐条结果和缺失项。", "", "统计仅覆盖固定试听摘录；不批准整体质量、不验证听审者身份，也不选择默认引擎。"]
        (output / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    except Exception as error:
        report.update({"validation": "invalid", "error": str(error), "acceptance": "not-evaluated"})
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"validation": report["validation"], "reviewStatus": report.get("result", {}).get("reviewStatus"), "report": str(output / "report.json"), "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["validation"] == "valid" else 1


if __name__ == "__main__":
    sys.exit(main())
