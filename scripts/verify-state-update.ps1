[CmdletBinding()]
param([string]$Root, [string]$ReportPath)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$package = Get-Content -LiteralPath (Join-Path $rootPath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$authoritySchema = [int]$package.codingHarness.authoritySchema
if ($authoritySchema -lt 1) { throw 'package.json authority schema is invalid.' }
if (-not $ReportPath) { $ReportPath = Join-Path $rootPath 'reports\state-update-validation.json' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pch-state-' + [guid]::NewGuid().ToString('N'))
$failures = New-Object Collections.Generic.List[string]
$utf8 = New-Object Text.UTF8Encoding($false)
try {
    [IO.Directory]::CreateDirectory((Join-Path $testRoot 'manifests')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $testRoot 'scripts')) | Out-Null
    [IO.File]::Copy((Join-Path $rootPath 'manifests\PROJECT-STATE.json'), (Join-Path $testRoot 'manifests\PROJECT-STATE.json'))
    [IO.File]::Copy((Join-Path $rootPath 'PROJECT-STATUS.md'), (Join-Path $testRoot 'PROJECT-STATUS.md'))
    [IO.File]::Copy((Join-Path $rootPath 'scripts\update-project-state.ps1'), (Join-Path $testRoot 'scripts\update-project-state.ps1'))
    [IO.File]::Copy((Join-Path $rootPath 'package.json'), (Join-Path $testRoot 'package.json'))
    $baseline = Get-Content -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $patchPath = Join-Path $testRoot 'patch.json'
    $patch = [ordered]@{ authority_schema = $authoritySchema; current_stage = 'STATE_UPDATE_SELF_TEST'; append_decisions = @('State update self-test') }
    [IO.File]::WriteAllText($patchPath, (($patch | ConvertTo-Json -Depth 10) + "`n"), $utf8)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot 'scripts\update-project-state.ps1') -Root $testRoot -PatchJsonPath $patchPath | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures.Add('Valid state patch failed.') }
    $updated = Get-Content -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($updated.current_stage -ne 'STATE_UPDATE_SELF_TEST' -or [int]$updated.state_generation -ne [int]$baseline.state_generation + 1) {
        $failures.Add('State patch was not applied atomically with one generation increment.')
    }
    $projection = Get-Content -LiteralPath (Join-Path $testRoot 'PROJECT-STATUS.md') -Raw -Encoding UTF8
    if (-not $projection.Contains('STATE_UPDATE_SELF_TEST')) { $failures.Add('Markdown projection was not regenerated.') }
    $receipt = $updated.completed_receipts[0]
    $receiptPatch = [ordered]@{ update_completed_receipts = @([ordered]@{
        id = [string]$receipt.id
        result = [string]$receipt.result
        evidence = ([string]$receipt.evidence + ' State updater replacement self-test.')
    }) }
    $receiptPatchPath = Join-Path $testRoot 'receipt-patch.json'
    [IO.File]::WriteAllText($receiptPatchPath, (($receiptPatch | ConvertTo-Json -Depth 10) + "`n"), $utf8)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot 'scripts\update-project-state.ps1') -Root $testRoot -PatchJsonPath $receiptPatchPath | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures.Add('Valid completed receipt replacement failed.') }
    $receiptUpdated = Get-Content -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ([string]$receiptUpdated.completed_receipts[0].evidence).EndsWith('State updater replacement self-test.')) {
        $failures.Add('Completed receipt replacement was not persisted.')
    }
    $badPath = Join-Path $testRoot 'bad.json'
    [IO.File]::WriteAllText($badPath, '{"unknown_property":true}', $utf8)
    $before = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    $process = Start-Process -FilePath (Get-Command powershell).Source -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$(Join-Path $testRoot 'scripts\update-project-state.ps1')`"",'-Root',"`"$testRoot`"",'-PatchJsonPath',"`"$badPath`"") -WindowStyle Hidden -Wait -PassThru
    $after = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    if ($process.ExitCode -eq 0 -or $before -ne $after) { $failures.Add('Invalid state patch did not fail without mutation.') }
    $badVerificationPath = Join-Path $testRoot 'bad-verification.json'
    [IO.File]::WriteAllText($badVerificationPath, '{"verification":{"result":"PASS","commands":"npm test","tests_passed":1,"tests_skipped":0,"report_sha256":null}}', $utf8)
    $before = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    $process = Start-Process -FilePath (Get-Command powershell).Source -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$(Join-Path $testRoot 'scripts\update-project-state.ps1')`"",'-Root',"`"$testRoot`"",'-PatchJsonPath',"`"$badVerificationPath`"") -WindowStyle Hidden -Wait -PassThru
    $after = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    if ($process.ExitCode -eq 0 -or $before -ne $after) { $failures.Add('Invalid verification contract did not fail without mutation.') }
    $badReceiptPath = Join-Path $testRoot 'bad-receipt.json'
    [IO.File]::WriteAllText($badReceiptPath, '{"append_completed_receipts":[{"id":"BAD","result":"PASS","summary":"not evidence"}]}', $utf8)
    $before = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    $process = Start-Process -FilePath (Get-Command powershell).Source -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$(Join-Path $testRoot 'scripts\update-project-state.ps1')`"",'-Root',"`"$testRoot`"",'-PatchJsonPath',"`"$badReceiptPath`"") -WindowStyle Hidden -Wait -PassThru
    $after = (Get-FileHash -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Algorithm SHA256).Hash
    if ($process.ExitCode -eq 0 -or $before -ne $after) { $failures.Add('Invalid completed receipt did not fail without mutation.') }
} catch { $failures.Add($_.Exception.Message) }
finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
        [IO.Directory]::Delete($resolved, $true)
    }
}
$result = [ordered]@{ status=if($failures.Count){'FAIL'}else{'PASS'}; failures=@($failures) }
[IO.Directory]::CreateDirectory((Split-Path -Parent ([IO.Path]::GetFullPath($ReportPath)))) | Out-Null
$json = ($result | ConvertTo-Json -Depth 10) + "`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), $json, $utf8)
$json
if ($failures.Count) { exit 1 }
