param(
    [Parameter(Mandatory = $true)][string]$Component,
    [ValidateSet('whisperx', 'paraformer')][string]$Engine = 'whisperx',
    [string]$Audio = '',
    [string]$AppRoot = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$sourceApp = if ($AppRoot) { (Resolve-Path -LiteralPath $AppRoot).Path } else { $repo }
$componentPath = (Resolve-Path -LiteralPath $Component).Path
$bundleRoot = Split-Path -Parent $componentPath
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$ownedBundle = (Get-Content -LiteralPath (Join-Path $repo 'cache/asr-runtime-source/relocated-path.txt') -Raw).Trim()
if (-not $bundleRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $bundleRoot -ne [IO.Path]::GetFullPath($ownedBundle) -or
    -not (Test-Path -LiteralPath (Join-Path $bundleRoot 'bundle-manifest.json'))) {
    throw 'Only this task''s previously extracted, owned temporary bundle may receive test ACLs.'
}
$testRoot = Join-Path $tempRoot ('听读只读验收 ' + [Guid]::NewGuid().ToString('N'))
$appCopy = Join-Path $testRoot '只读应用 app'
$reportPath = Join-Path $repo ('cache/asr-runtime-source/readonly-offline-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '.json')
$logPath = [IO.Path]::ChangeExtension($reportPath, '.log')
$aclBackupPath = [IO.Path]::ChangeExtension($reportPath, '.acl.json')
$report = [ordered]@{ status = 'running'; sourceApp = $sourceApp; appPath = $appCopy; component = $componentPath; engine = $Engine; aclRestored = $false; probes = @(); appReport = $null; error = $null }
$saved = @()

function Confirm-WriteDenied([string]$FilePath) {
    try {
        $stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    } catch [UnauthorizedAccessException] {
        $script:report.probes += $FilePath
        return
    }
    throw "The test path is writable: $FilePath"
}

try {
    New-Item -ItemType Directory -Path (Join-Path $appCopy 'python') | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceApp 'out') -Destination $appCopy -Recurse
    Copy-Item -LiteralPath (Join-Path $sourceApp 'package.json') -Destination $appCopy
    Get-ChildItem -LiteralPath (Join-Path $sourceApp 'python') -Filter 'asr_*.py' -File | Copy-Item -Destination (Join-Path $appCopy 'python')
    Copy-Item -LiteralPath (Join-Path $sourceApp 'python/evaluation-models.json') -Destination (Join-Path $appCopy 'python')
    # Explicit preview/package projects carry the frozen production dependency tree.
    if ($AppRoot -and (Test-Path -LiteralPath (Join-Path $sourceApp 'node_modules'))) {
        Copy-Item -LiteralPath (Join-Path $sourceApp 'node_modules') -Destination $appCopy -Recurse
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rights = [Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes'
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit,
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
    foreach ($target in @($appCopy, $bundleRoot)) {
        $acl = Get-Acl -LiteralPath $target
        $saved += @{ path = $target; sddl = $acl.Sddl }
        # Keep a recovery record even if the test shell is externally interrupted.
        $saved | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $aclBackupPath -Encoding utf8
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $target -AclObject $acl
    }
    # Open for writing without changing any bytes; require real AccessDenied.
    Confirm-WriteDenied (Join-Path $appCopy 'out/main/index.js')
    Confirm-WriteDenied (Join-Path $appCopy 'python/asr_worker.py')
    Confirm-WriteDenied (Join-Path $appCopy 'python/asr_compat.py')
    Confirm-WriteDenied (Join-Path $appCopy 'python/asr_ctc.py')
    Confirm-WriteDenied (Join-Path $appCopy 'python/asr_engines.py')
    Confirm-WriteDenied (Join-Path $bundleRoot 'python/python.exe')
    Confirm-WriteDenied (Join-Path $bundleRoot 'python/Lib/site-packages/torch/__init__.py')
    Confirm-WriteDenied (Join-Path $bundleRoot 'python/Lib/site-packages/funasr/models/paraformer/model.py')
    Confirm-WriteDenied (Join-Path $bundleRoot 'python/Lib/site-packages/whisperx/alignment.py')
    Confirm-WriteDenied (Join-Path $bundleRoot 'resources/nltk/tokenizers/punkt_tab/english/abbrev_types.txt')
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    $appArguments = @('--import', 'tsx', (Join-Path $repo 'tests/model/app-transcription.ts'), '--component', $componentPath, '--app-path', $appCopy, '--isolated-runtime', '--offline-ui', '--engine', $Engine)
    if ($Audio) { $appArguments += @('--audio', (Resolve-Path -LiteralPath $Audio).Path) }
    & node @appArguments 2>&1 |
        Tee-Object -LiteralPath $logPath
    if ($LASTEXITCODE -ne 0) { throw 'Read-only/offline application acceptance failed. See the application report and log.' }
    $last = Get-Content -LiteralPath $logPath -Tail 1 | ConvertFrom-Json
    $report.appReport = $last.report
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
} finally {
    $restoreErrors = @()
    foreach ($entry in $saved) {
        try {
            $original = [Security.AccessControl.DirectorySecurity]::new()
            $original.SetSecurityDescriptorSddlForm($entry.sddl)
            Set-Acl -LiteralPath $entry.path -AclObject $original
            if ((Get-Acl -LiteralPath $entry.path).Sddl -ne $entry.sddl) { throw 'ACL did not restore exactly' }
        } catch { $restoreErrors += $_.Exception.Message }
    }
    $report.aclRestored = $restoreErrors.Count -eq 0
    if (-not $report.aclRestored) { $report.status = 'failed'; $report.error = $restoreErrors -join '; ' }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
$report | ConvertTo-Json -Depth 8
if ($report.status -ne 'passed') { exit 1 }
