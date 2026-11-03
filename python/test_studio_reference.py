import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

import studio_reference as studio
from studio_reference import expected_reference, parse_content


class StudioReferenceTests(unittest.TestCase):
    def test_human_characters_are_kept_and_pinyin_is_not_scored_as_text(self):
        value = parse_content('SSB00090030.wav\t碗 wan2 碗 wan3 香 xiang1\n'.encode())
        self.assertEqual(value['SSB00090030.wav'], {'text': '碗碗香', 'pinyin': ['wan2', 'wan3', 'xiang1']})

    def test_short_number_reference_is_not_filtered_or_rewritten(self):
        rows = parse_content('SSB00090179.wav\t一 yi1\n'.encode())
        row = expected_reference('SSB00090179.wav', {**rows['SSB00090179.wav'], 'speaker': 'SSB0009', 'entry': 'published.wav'})
        self.assertEqual(row['reference'], [{'id': 'SSB00090179', 'text': '一'}])
        self.assertEqual(row['category'], 'numeric-characters-only')
        self.assertNotIn('startMs', row['reference'][0])

    def test_duplicate_utterance_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            parse_content(('SSB00090179.wav\t一 yi1\n' * 2).encode())

    def test_missing_pair_or_unexpected_token_is_not_silently_removed(self):
        for payload in ('一', '一 yi1 leftover', '一 missingtone', 'abc abc1', '一 yi1 #3 p3'):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_content(f'SSB00090179.wav\t{payload}\n'.encode())

    def test_filename_cannot_be_a_path(self):
        with self.assertRaises(ValueError):
            parse_content('../elsewhere.wav\t一 yi1\n'.encode())


class RelocatedStudioToolsTests(unittest.TestCase):
    """Invented source bytes; no executable, model or network operation occurs."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.manifest = self.root / 'manifest.json'
        self.tools = {}
        for name in ('ffmpeg', 'ffprobe'):
            path = self.root / f'{name}.exe'
            path.write_bytes(f'Never-executed fixture {name}'.encode())
            self.tools[name] = str(path)
        filename = 'SSB00090001.wav'
        source = self.root / 'original' / filename
        target = self.root / 'pcm16' / filename
        source.parent.mkdir()
        target.parent.mkdir()
        source.write_bytes(b'Invented original archive member')
        self.pcm = b'\0\0' * 160
        with wave.open(str(target), 'wb') as stream:
            stream.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            stream.writeframes(self.pcm)
        annotation = b'invented published labels'
        row = {'speaker': 'SSB0009', 'entry': 'fixture/member.wav', 'text': '甲', 'pinyin': ['jia3']}
        self.value = {
            'version': 1, 'referenceKind': 'human-studio-text', 'selection': studio.SELECTION,
            'source': {'archiveSha256': studio.ARCHIVE_SHA256, 'archivePath': str(self.root / 'unused.rar'),
                       'annotationSha256': hashlib.sha256(annotation).hexdigest()},
            'tools': {'archiveReader': 'unchanged-fixture-reader', **{
                name: {'path': str(self.root / 'missing-history' / f'{name}.exe'),
                       'sha256': studio.digest(path)} for name, path in self.tools.items()}},
            'samples': [{**expected_reference(filename, row), 'sourcePath': str(source), 'path': str(target),
                         'sourceSha256': studio.digest(source), 'audioHash': studio.digest(target),
                         'frames': 160, 'durationMs': 10}],
        }
        self.manifest.write_text(json.dumps(self.value), encoding='utf-8')
        self.original = self.manifest.read_bytes()
        for name, value in [('verify_archive', self.root / 'unused.rar'),
                            ('source_rows', (annotation, [(filename, row)])),
                            ('member', source.read_bytes()), ('pcm', self.pcm), ('duration_ms', 10)]:
            mocked = patch.object(studio, name, return_value=value)
            setattr(self, name, mocked.start())
            self.addCleanup(mocked.stop)

    def test_explicit_byte_identical_tools_validate_original_pcm_without_rewriting_the_manifest(self):
        result = studio.load_studio_manifest(self.manifest, tool_overrides=self.tools)
        self.assertEqual(result, self.value)
        self.assertEqual(self.manifest.read_bytes(), self.original)
        self.pcm.assert_called_once_with(self.tools['ffmpeg'], self.root / 'original' / 'SSB00090001.wav')
        self.duration_ms.assert_called_once_with(self.tools['ffprobe'], self.root / 'pcm16' / 'SSB00090001.wav')
        self.source_rows.assert_called_once_with('unchanged-fixture-reader', self.root / 'unused.rar')

    def test_default_verification_keeps_using_recorded_paths_and_never_guesses_a_replacement(self):
        with self.assertRaises(FileNotFoundError):
            studio.load_studio_manifest(self.manifest)
        self.pcm.assert_not_called()
        self.assertEqual(self.manifest.read_bytes(), self.original)

    def test_override_never_accepts_a_different_binary_even_if_it_has_the_same_filename(self):
        Path(self.tools['ffmpeg']).write_bytes(b'Unapproved replacement binary')
        with self.assertRaisesRegex(ValueError, 'preparation tool changed'):
            studio.load_studio_manifest(self.manifest, tool_overrides=self.tools)
        self.pcm.assert_not_called()

    def test_only_explicit_absolute_ffmpeg_and_ffprobe_overrides_are_allowed(self):
        for tools in ({'archiveReader': self.tools['ffmpeg']}, {'ffmpeg': 'relative.exe'},
                      {'ffmpeg': ''}, {'ffmpeg': 1}, {'ffprobe': self.tools['ffprobe'] + '\0'}, []):
            with self.subTest(tools=tools), self.assertRaisesRegex(ValueError, 'explicit absolute'):
                studio.load_studio_manifest(self.manifest, tool_overrides=tools)
        self.pcm.assert_not_called()


if __name__ == '__main__':
    unittest.main()
