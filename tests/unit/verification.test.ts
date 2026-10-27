import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyVerification } from '../../scripts/verification-status'

test('verification recognizes localized Device Guard startup blocks without masking actual failures', () => {
  for (const output of [
    "The program was blocked by your organization's Device Guard policy. <process did exit: exitCode=4551, signal=null>",
    '程序已被组织的 Device Guard 策略阻止。 <process did exit: exitCode=4551, signal=null>',
    'Device Guard ������ֹ <process did exit: exitCode=4551, signal=null>',
  ])
    assert.equal(classifyVerification(1, output).status, 'blocked')
  assert.equal(classifyVerification(1, 'Process failed to launch! exitCode=1').status, 'failed')
  assert.equal(classifyVerification(1, 'Expected 3, received 2').status, 'failed')
  assert.equal(classifyVerification(null, '', 'ENOENT').status, 'failed')
  assert.equal(classifyVerification(0, '15 passed').status, 'passed')
})
