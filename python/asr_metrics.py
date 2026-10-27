"""Evaluation helpers. No model dependency is needed to test these calculations."""

import math
import unicodedata


def normalize_text(text):
    return "".join(
        char
        for char in unicodedata.normalize("NFKC", text).casefold()
        if unicodedata.category(char)[0] in ("L", "N")
    )


def character_error_rate(reference, hypothesis):
    reference, hypothesis = normalize_text(reference), normalize_text(hypothesis)
    if not reference:
        raise ValueError("CER requires a nonempty reference")
    row = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        following = [i]
        for j, actual in enumerate(hypothesis, 1):
            following.append(
                min(row[j] + 1, following[j - 1] + 1, row[j - 1] + (expected != actual))
            )
        row = following
    return {
        "referenceCharacters": len(reference),
        "hypothesisCharacters": len(hypothesis),
        "editDistance": row[-1],
        "cer": row[-1] / len(reference),
        "normalization": "NFKC, casefold, letters and numbers only; no number conversion",
    }


def timing_issues(segments, duration_ms):
    issues = []
    previous_end = 0
    for index, segment in enumerate(segments):
        start, end = segment.get("startMs"), segment.get("endMs")
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end)):
            issues.append({"index": index, "reason": "missing or nonfinite time"})
            continue
        if start < 0 or end > duration_ms or start >= end:
            issues.append({"index": index, "reason": "out of bounds or empty interval"})
        if start < previous_end:
            issues.append({"index": index, "reason": "overlapping or out of order"})
        previous_end = end
    return issues


def transcript_document(audio_hash, offset_ms, duration_ms, segments):
    issues = timing_issues(segments, duration_ms)
    if issues:
        raise ValueError(f"Cannot export invalid model times: {issues}")
    return {
        "version": 1,
        "audioHash": audio_hash,
        "kind": "transcript",
        "coverage": [{"startMs": offset_ms, "endMs": offset_ms + duration_ms}],
        "segments": [
            {
                "id": f"asr-{offset_ms}-{index + 1}",
                "startMs": offset_ms + segment["startMs"],
                "endMs": offset_ms + segment["endMs"],
                "text": segment["text"].strip(),
            }
            for index, segment in enumerate(segments)
            if segment["text"].strip()
        ],
    }


def reference_boundary_comparison(reference_segments, timed_units):
    """Only compare exact matching reference strings; never infer times for errors.

    The reference fixture records synthesis placement, not human phoneme labels.
    This is a coarse boundary check, not a measured forced-alignment accuracy.
    """
    text, character_times = "", []
    for unit in timed_units:
        normalized = normalize_text(unit["text"])
        text += normalized
        character_times.extend([(unit.get("startMs"), unit.get("endMs"))] * len(normalized))
    matches = []
    cursor = 0
    for segment in reference_segments:
        expected = normalize_text(segment["text"])
        index = text.find(expected, cursor) if expected else -1
        if index == -1:
            matches.append({"id": segment["id"], "matched": False})
            continue
        start, end = character_times[index][0], character_times[index + len(expected) - 1][1]
        valid = start is not None and end is not None
        matches.append({
            "id": segment["id"], "matched": valid,
            "startDeltaMs": start - segment["startMs"] if valid else None,
            "endDeltaMs": end - segment["endMs"] if valid else None,
        })
        cursor = index + len(expected)
    return {"referenceType": "synthesis placement, not human alignment ground truth", "sentences": matches}
