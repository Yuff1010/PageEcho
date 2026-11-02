import importlib.metadata
import unittest
from unittest.mock import patch

from asr_security import component_security_issues
from asr_jobs import JobError
from asr_worker import build_pipeline


class ComponentSecurityTests(unittest.TestCase):
    def versions(self, **changes):
        values = {'filelock': '4.2.1', 'hydra-core': '1.3.8', 'nltk': '3.10.4',
                  'pillow': '13.0.0', 'setuptools': '84.1.0'}
        values.update(changes)
        return values.__getitem__

    def test_patched_component_and_stable_local_wheels_are_accepted(self):
        self.assertEqual(component_security_issues(self.versions()), [])
        self.assertEqual(component_security_issues(self.versions(filelock='4.2.1.post1+local')), [])

    def test_old_bundle_is_reported_with_an_action_without_loading_models(self):
        issues = component_security_issues(self.versions(filelock='3.32.3', **{'hydra-core': '1.3.7'}))
        self.assertEqual(len(issues), 2)
        self.assertTrue(any('filelock' in value and '4.2.1' in value for value in issues))
        self.assertTrue(any('hydra-core' in value and '1.3.8' in value for value in issues))
        self.assertTrue(all('普通播放仍可使用' in value for value in issues))

    def test_prerelease_malformed_and_missing_metadata_are_not_silently_trusted(self):
        for version in ['4.2.1rc1', 'unversioned', '4.2', '4.2.1\n']:
            with self.subTest(version=version):
                self.assertEqual(len(component_security_issues(self.versions(filelock=version))), 1)
        def missing(name):
            raise importlib.metadata.PackageNotFoundError(name)
        self.assertEqual(len(component_security_issues(missing)), 5)

    def test_direct_worker_start_cannot_bypass_the_component_check(self):
        with patch('asr_worker.component_security_issues', return_value=['组件需要安全更新']), \
                patch('asr_worker.configure_cache') as cache:
            with self.assertRaisesRegex(JobError, '安全更新'):
                build_pipeline(object())
            cache.assert_not_called()
