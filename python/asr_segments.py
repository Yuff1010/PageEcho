"""Preserve media coordinates and text when joining overlapping ASR windows."""

import hashlib
from difflib import SequenceMatcher
import json
import unicodedata

from asr_metrics import normalize_text

POSTPROCESS_VERSION = 3
SENTENCE_PUNCTUATION = frozenset('，。！？；：、,.!?;:…')


def alignment_text(text):
    return ''.join(char for char in unicodedata.normalize('NFKC', text).casefold()
                   if not char.isspace() and unicodedata.category(char)[0] not in ('P', 'Z'))


def punctuation_content(text):
    return ''.join(char for char in unicodedata.normalize('NFKC', text).casefold()
                   if not char.isspace() and char not in SENTENCE_PUNCTUATION)


def fingerprint(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def windows(start_ms, end_ms, chunk_ms=30000, overlap_ms=2000):
    if not (type(start_ms) is int and type(end_ms) is int and 0 <= start_ms < end_ms):
        raise ValueError('Invalid requested media range')
    if not 5000 <= chunk_ms <= 60000 or not 0 <= overlap_ms <= 5000:
        raise ValueError('Invalid chunk configuration')
    for index, start in enumerate(range(start_ms, end_ms, chunk_ms)):
        end = min(end_ms, start + chunk_ms)
        yield {'index': index, 'startMs': start, 'endMs': end,
               'decodeStartMs': max(start_ms, start - overlap_ms),
               'decodeEndMs': min(end_ms, end + overlap_ms)}


def lexical_units(raw_units, duration_ms):
    """Keep genuine character/word times; untimed punctuation attaches to text.

    Lexical characters without alignment fail explicitly. Overlapping character
    times can be retained inside one reading segment, but never made up.
    """
    units, leading = [], ''
    for raw in raw_units:
        text = raw['text']
        if not normalize_text(text):
            if units:
                units[-1]['text'] += text
            else:
                leading += text
            continue
        start, end = raw.get('startMs'), raw.get('endMs')
        if not all(type(value) is int for value in (start, end)):
            raise ValueError('Recognized characters have no alignment')
        if not 0 <= start < end <= duration_ms:
            raise ValueError(f'Invalid native unit time [{start}, {end}] for {duration_ms} ms')
        if units and start < units[-1]['startMs']:
            raise ValueError('Model unit times are out of order')
        units.append({'text': leading + text, 'startMs': start, 'endMs': end})
        leading = ''
    return units


def punctuate_units(units, restored):
    """Place only punctuation/whitespace on existing time anchors, no rewriting."""
    original = ''.join(unit['text'] for unit in units)
    if punctuation_content(original) != punctuation_content(restored):
        raise ValueError('Punctuation model changed recognized characters')
    # Positions are in the same normalized letters used for the comparison.
    separators, position = {}, 0
    for char in restored:
        if not char.isspace() and char not in SENTENCE_PUNCTUATION:
            position += len(punctuation_content(char))
        else:
            separators[position] = separators.get(position, '') + char
    output, position = [], 0
    for unit in units:
        text = unit['text']
        letters = ''.join(char for char in text if not char.isspace() and char not in SENTENCE_PUNCTUATION)
        start = position
        position += len(punctuation_content(letters))
        if any(separators.get(index, '').strip() for index in range(start + 1, position)):
            raise ValueError('Punctuation appeared inside an indivisible model token')
        prefix = separators.get(0, '') if not output else ''
        output.append({**unit, 'text': prefix + letters + separators.get(position, '')})
    return output


def owned_units(units, window):
    result = []
    offset = window['decodeStartMs']
    for unit in units:
        start, end = offset + unit['startMs'], offset + unit['endMs']
        if window['startMs'] * 2 <= start + end < window['endMs'] * 2:
            result.append({**unit, 'startMs': start, 'endMs': end})
    return result


def join_units(previous, following):
    """Deduplicate an equal, temporally overlapping suffix/prefix.

    Repeated words at different times remain. Conflicting overlaps retain both
    texts and emit a review warning; grouping prevents invalid sentence ranges.
    Original model output is retained in each checkpoint for later correction.
    """
    issues, count = [], 0
    for length in range(min(100, len(previous), len(following)), 0, -1):
        left, right = previous[-length:], following[:length]
        if all(alignment_text(a['text']) == alignment_text(b['text']) and
               min(a['endMs'], b['endMs']) > max(a['startMs'], b['startMs']) and
               abs(a['startMs'] + a['endMs'] - b['startMs'] - b['endMs']) <= 800
               for a, b in zip(left, right)):
            count = length
            break
    if count:
        issues.append({'code': 'BOUNDARY_REPEAT_DEDUPLICATED', 'units': count,
                       'atMs': following[0]['startMs']})
    remaining = following[count:]
    if previous and remaining and previous[-1]['endMs'] > remaining[0]['startMs']:
        issues.append({'code': 'BOUNDARY_CONFLICT', 'atMs': remaining[0]['startMs']})
    return previous + remaining, issues


def overlap_agreement(left, right, seam_ms, margin_ms):
    """Find a unique exact context spanning both independently timed cuts.

    The agreement is between model outputs, never a human accuracy reference.
    Keep symbols/word punctuation significant; ignore only sentence separators.
    """
    def context(units):
        chars = [{'char': char, 'unit': index, 'startMs': unit['startMs'], 'endMs': unit['endMs']}
                 for index, unit in enumerate(units)
                 if abs((unit['startMs'] + unit['endMs']) / 2 - seam_ms) <= margin_ms
                 for char in punctuation_content(unit['text'])]
        flags = [char['startMs'] + char['endMs'] < 2 * seam_ms for char in chars]
        cut = sum(flags)
        if flags != [True] * cut + [False] * (len(chars) - cut):
            return [], 0
        start, end = max(0, cut - 60), min(len(chars), cut + 60)
        return chars[start:end], cut - start

    a, ca = context(left)
    b, cb = context(right)
    if not a or not b:
        return None
    ta, tb = ''.join(c['char'] for c in a), ''.join(c['char'] for c in b)
    matches = [m for m in SequenceMatcher(a=ta, b=tb, autojunk=False).get_matching_blocks()
               if m.size >= 4 and m.a <= ca <= m.a + m.size and m.b <= cb <= m.b + m.size]
    if len(matches) != 1:
        return None
    match = matches[0]
    text = tb[match.b:match.b + match.size]
    if ta.find(text) != ta.rfind(text) or tb.find(text) != tb.rfind(text):
        return None
    ac, bc = a[match.a:match.a + match.size], b[match.b:match.b + match.size]
    if any(abs(x['startMs'] + x['endMs'] - y['startMs'] - y['endMs']) > 2000 for x, y in zip(ac, bc)):
        return None
    return {'text': text, 'leftCut': ca - match.a, 'rightCut': cb - match.b,
            'leftCharacters': ac, 'rightCharacters': bc}


def join_windows(previous, following, left_context, right_context, seam_ms, margin_ms):
    """Reconcile whole native units by agreed occurrence, keeping original times."""
    if left_context is None or not margin_ms:
        return join_units(previous, following)
    agreement = overlap_agreement(left_context, right_context, seam_ms, margin_ms)
    issues = []

    def unresolved():
        issues.append({'code': 'BOUNDARY_CONTEXT_UNRESOLVED', 'atMs': seam_ms})

    def whole_units(chars):
        if not chars:
            return []
        indices = sorted({char['unit'] for char in chars})
        units = [right_context[index] for index in indices]
        if (indices != list(range(indices[0], indices[-1] + 1)) or
                ''.join(punctuation_content(unit['text']) for unit in units) != ''.join(c['char'] for c in chars)):
            return None
        return units

    if agreement is None:
        if all(any(abs((u['startMs'] + u['endMs']) / 2 - seam_ms) <= margin_ms for u in context)
               for context in (left_context, right_context)):
            unresolved()
    else:
        x, y = agreement['leftCut'], agreement['rightCut']
        if x != y:
            lo, hi = min(x, y), max(x, y)
            ac, bc = agreement['leftCharacters'][lo:hi], agreement['rightCharacters'][lo:hi]
            selected = whole_units(bc)
            compatible = all(min(a['endMs'], b['endMs']) > max(a['startMs'], b['startMs']) and
                             abs(a['startMs'] + a['endMs'] - b['startMs'] - b['endMs']) <= 800
                             for a, b in zip(ac, bc))
            left_prefix = agreement['text'][:x]
            prefix_matches = ''.join(punctuation_content(u['text']) for u in previous).endswith(left_prefix)
            if not selected or not compatible or not prefix_matches:
                unresolved()
            elif x < y:
                if ((previous and selected[0]['endMs'] <= previous[-1]['startMs']) or
                        (following and selected[-1]['startMs'] > following[0]['startMs']) or
                        any(u['startMs'] + u['endMs'] >= 2 * seam_ms for u in selected)):
                    unresolved()
                else:
                    following = selected + following
                    issues.append({'code': 'BOUNDARY_TEXT_RECOVERED', 'atMs': seam_ms, 'units': len(selected)})
            elif following[:len(selected)] != selected:
                unresolved()
            else:
                following = following[len(selected):]
                issues.append({'code': 'BOUNDARY_REPEAT_DEDUPLICATED', 'atMs': seam_ms, 'units': len(selected)})
        # Equal occurrence indices intentionally keep adjacent genuine repeats.
    if previous and following and previous[-1]['endMs'] > following[0]['startMs']:
        issues.append({'code': 'BOUNDARY_CONFLICT', 'atMs': following[0]['startMs']})
    return previous + following, issues


def reading_segments(units):
    segments, group = [], []

    def flush():
        if not group:
            return
        text = ''.join(unit['text'] for unit in group).strip()
        start, end = min(unit['startMs'] for unit in group), max(unit['endMs'] for unit in group)
        identifier = f"asr-{group[0]['startMs']}-{len(segments)}"
        while segments and start < segments[-1]['endMs']:
            # A native interval can cross more than one prior reading boundary.
            # Union all affected ranges and preserve recognized text order.
            previous = segments.pop()
            start, end = min(previous['startMs'], start), max(previous['endMs'], end)
            text, identifier = previous['text'] + text, previous['id']
        segments.append({'id': identifier, 'startMs': start, 'endMs': end, 'text': text})
        group.clear()

    for unit in units:
        if group:
            last = group[-1]
            boundary = last['text'].rstrip().endswith(tuple('，。！？；,!?;'))
            too_long = sum(len(item['text']) for item in group) >= 80
            pause = unit['startMs'] - last['endMs'] >= 600
            if boundary or too_long or pause:
                flush()
        group.append(unit)
    flush()
    return segments


def partial_document(audio_hash, range_start, processed_until, units):
    segments = reading_segments(units)
    end = max(processed_until, max((segment['endMs'] for segment in segments), default=processed_until))
    return {'version': 1, 'audioHash': audio_hash, 'kind': 'transcript',
            'coverage': [{'startMs': range_start, 'endMs': end}], 'segments': segments}
