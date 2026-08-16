[CmdletBinding()]
param(
    [string]$Root,
    [string]$ReportPath
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
if (-not $ReportPath) { $ReportPath = Join-Path $rootPath 'reports\lifecycle-validation.json' }
$tests = @('install.test.ps1', 'upgrade.test.ps1', 'uninstall.test.ps1')
$results = [Collections.Generic.List[object]]::new()
& npm --prefix $rootPath run build:runtime --silent
if ($LASTEXITCODE -ne 0) { throw "PCH runtime build failed with exit code $LASTEXITCODE." }
foreach ($test in $tests) {
    try {
        & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rootPath "tests\lifecycle\$test") -SkipRuntimeBuild
        if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
        $results.Add([ordered]@{ test = $test; status = 'PASS' })
    } catch {
        $results.Add([ordered]@{ test = $test; status = 'FAIL'; reason = $_.Exception.Message })
    }
}
$status = if ($results | Where-Object status -eq 'FAIL') { 'FAIL' } else { 'PASS' }
$report = [ordered]@{ schema_version = 1; status = $status; tests = $results.ToArray() }
New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
[IO.File]::WriteAllText($ReportPath, (($report | ConvertTo-Json -Depth 8) + "`n"), (New-Object Text.UTF8Encoding($false)))
$report | ConvertTo-Json -Depth 8
if ($status -eq 'FAIL') { exit 1 }
