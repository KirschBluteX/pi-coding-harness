[CmdletBinding()]
param([string]$Root, [string]$ReportPath)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
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
    $baseline = Get-Content -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $patchPath = Join-Path $testRoot 'patch.json'
    [IO.File]::WriteAllText($patchPath, '{"current_stage":"STATE_UPDATE_SELF_TEST","append_decisions":["State update self-test"]}', $utf8)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot 'scripts\update-project-state.ps1') -Root $testRoot -PatchJsonPath $patchPath | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures.Add('Valid state patch failed.') }
    $updated = Get-Content -LiteralPath (Join-Path $testRoot 'manifests\PROJECT-STATE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($updated.current_stage -ne 'STATE_UPDATE_SELF_TEST' -or [int]$updated.state_generation -ne [int]$baseline.state_generation + 1) {
        $failures.Add('State patch was not applied atomically with one generation increment.')
    }
    $projection = Get-Content -LiteralPath (Join-Path $testRoot 'PROJECT-STATUS.md') -Raw -Encoding UTF8
    if (-not $projection.Contains('STATE_UPDATE_SELF_TEST')) { $failures.Add('Markdown projection was not regenerated.') }
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
