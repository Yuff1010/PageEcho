import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditPythonPins,
  groupPythonAdvisories,
  parsePythonPins,
} from '../../scripts/maintenance/audit-python-dependencies'

test('Python audit joins canonical exact pins across CPU/CUDA without hiding their source versions', () => {
  const pins = parsePythonPins([
    {
      source: 'cpu',
      content:
        '# component\n--extra-index-url https://download.pytorch.org/whl/cpu\ntorch==2.8.0+cpu\nHydra_Core==1.3.8\n',
    },
    { source: 'cuda', content: 'torch==2.8.0+cu128\nhydra-core==1.3.8\n' },
  ])
  assert.equal(pins.length, 2)
  assert.deepEqual(
    pins.find((pin) => pin.name === 'torch'),
    {
      name: 'torch',
      version: '2.8.0',
      originalVersions: ['2.8.0+cpu', '2.8.0+cu128'],
      sources: ['cpu', 'cuda'],
    },
  )
  for (const content of [
    '',
    'x>=1.0',
    'x==1.0\nX==1.1',
    '-r private.txt',
    '--index-url https://example.com',
    'x @ https://example.com/x.whl',
  ])
    assert.throws(() => parsePythonPins([{ source: 'invalid', content }]))
})

test('Python advisory aliases are transitive groups and keep independent records and maximum declared severity', () => {
  const grouped = groupPythonAdvisories([
    { id: 'GHSA-one', aliases: ['CVE-one'], database_specific: { severity: 'HIGH' } },
    { id: 'PYSEC-one', aliases: ['CVE-one', 'GHSA-one'] },
    { id: 'GHSA-other', database_specific: { severity: 'MODERATE' } },
  ])
  assert.equal(grouped.length, 2)
  assert.deepEqual(grouped.find((item) => item.id === 'GHSA-one')?.ids, ['GHSA-one', 'PYSEC-one'])
  assert.equal(grouped.find((item) => item.id === 'GHSA-one')?.severity, 'HIGH')
})

test('Python audit queries every declared package and reports raw aliases without suppressing affected pins', async () => {
  const pins = parsePythonPins([{ source: 'fixture', content: 'alpha==1.0\nbeta==2.0' }])
  const calls: string[] = []
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    if (url.endsWith('/querybatch')) {
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(
        body.queries.map((item: { package: { name: string } }) => item.package.name),
        ['alpha', 'beta'],
      )
      return Response.json({ results: [{ vulns: [{ id: 'GHSA-one' }, { id: 'PYSEC-one' }] }, {}] })
    }
    const id = url.split('/').at(-1)!
    return Response.json({
      id,
      aliases: ['CVE-one'],
      affected: [{ package: { name: 'alpha', ecosystem: 'PyPI' } }],
    })
  }
  const report = await auditPythonPins(pins, { fetch: request })
  assert.equal(report.packageVersions, 2)
  assert.equal(report.affectedPackageVersions, 1)
  assert.equal(report.rawAdvisoryRecords, 2)
  assert.equal(report.advisoryGroups.length, 1)
  assert.equal(report.findings[0]?.name, 'alpha')
  assert.equal(calls.length, 3)
})

test('Python audit refuses pagination instead of labelling the first page a complete scan', async () => {
  const pins = parsePythonPins([{ source: 'fixture', content: 'alpha==1.0' }])
  await assert.rejects(
    auditPythonPins(pins, {
      fetch: async () => Response.json({ results: [{ vulns: [], next_page_token: 'more' }] }),
    }),
    /paginated.*incomplete/,
  )
})

test('Python audit refuses partial, malformed, failed and oversized responses instead of reporting a clean audit', async () => {
  const pins = parsePythonPins([{ source: 'fixture', content: 'alpha==1.0' }])
  for (const response of [
    Response.json({ results: [] }),
    Response.json({ results: [null] }),
    Response.json({ results: [{ vulns: [{ id: '../other' }] }] }),
    new Response('failure', { status: 500 }),
  ])
    await assert.rejects(auditPythonPins(pins, { fetch: async () => response }))
  await assert.rejects(
    auditPythonPins(pins, {
      responseBytes: 8,
      fetch: async () => Response.json({ results: [{}] }),
    }),
    /byte budget/,
  )
  await assert.rejects(
    auditPythonPins(pins, {
      fetch: async (url) =>
        String(url).endsWith('/querybatch')
          ? Response.json({ results: [{ vulns: [{ id: 'GHSA-one' }] }] })
          : Response.json({ id: 'GHSA-different' }),
    }),
    /identity/,
  )
})
