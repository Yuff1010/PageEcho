"""Summary-entry controls use synthetic metadata, no model or public dataset."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import reference_summary as summary


class ReferenceSummaryEntryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.report = self.root / 'report.json'
        self.manifest = self.root / 'manual.json'
        self.report.write_text(json.dumps({'status': 'passed', 'referenceKind': 'human-studio-text',
                                           'manifestPath': str(self.manifest)}), encoding='utf-8')
        self.tools = {'ffmpeg': str(self.root / 'ffmpeg.exe'), 'ffprobe': str(self.root / 'ffprobe.exe')}

    def test_studio_summary_forwards_override_to_the_manifest_validator_instead_of_skipping_it(self):
        with patch.object(summary, 'load_studio_manifest', side_effect=ValueError('pinned tool rejected')) as validate:
            with self.assertRaisesRegex(ValueError, 'pinned tool rejected'):
                summary.summarize(self.report, tool_overrides=self.tools)
        validate.assert_called_once_with(str(self.manifest), tool_overrides=self.tools)

    def test_override_is_not_silently_ignored_for_a_different_reference_type(self):
        self.report.write_text(json.dumps({'status': 'passed', 'referenceKind': 'human-isolated',
                                           'manifestPath': str(self.manifest)}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'only to studio'):
            summary.summarize(self.report, tool_overrides=self.tools)

    def test_cli_requires_both_preparation_tools_before_reading_any_report(self):
        for name in ('--ffmpeg', '--ffprobe'):
            argv = ['reference_summary.py', str(self.report), '--output', str(self.root / 'new.json'), name, self.tools[name[2:]]]
            with patch('sys.argv', argv), patch.object(summary, 'summarize') as score, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    summary.main()
                self.assertEqual(error.exception.code, 2)
                score.assert_not_called()

    def test_cli_preserves_an_existing_output_and_does_not_score_before_rejecting(self):
        output = self.root / 'historical-summary.json'
        output.write_bytes(b'Preserve existing evidence')
        with patch('sys.argv', ['reference_summary.py', str(self.report), '--output', str(output)]), patch.object(summary, 'summarize') as score:
            with self.assertRaisesRegex(ValueError, 'must not be overwritten'):
                summary.main()
            score.assert_not_called()
        self.assertEqual(output.read_bytes(), b'Preserve existing evidence')


if __name__ == '__main__':
    unittest.main()
