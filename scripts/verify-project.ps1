[CmdletBinding()]
param([string]$Root, [string]$ReportPath, [switch]$SkipPerformance, [switch]$SkipLifecycle)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
if (-not $ReportPath) { $ReportPath = Join-Path $rootPath 'reports\verification-summary.json' }
[IO.Directory]::CreateDirectory((Split-Path -Parent ([IO.Path]::GetFullPath($ReportPath)))) | Out-Null
$steps = [Collections.Generic.List[object]]::new()
$failures = [Collections.Generic.List[string]]::new()
$testReportPath = Join-Path $rootPath 'reports\vitest-summary.json'
$vitest = Join-Path $rootPath 'node_modules\.bin\vitest.cmd'
$testSummary = $null

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    $started = [Diagnostics.Stopwatch]::StartNew()
    try {
        $global:LASTEXITCODE = 0
        & $Action
        if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
        $steps.Add([ordered]@{ name=$Name; status='PASS'; elapsed_ms=$started.ElapsedMilliseconds })
    } catch {
        $steps.Add([ordered]@{ name=$Name; status='FAIL'; elapsed_ms=$started.ElapsedMilliseconds; reason=$_.Exception.Message })
        $failures.Add("$Name`: $($_.Exception.Message)")
        throw
    }
}

$overall = [Diagnostics.Stopwatch]::StartNew()
try {
    Invoke-Step 'release-surface' {
        $required = @('README.md','AGENTS.md','PROJECT-STATUS.md','docs/PI-CODING-HARNESS-BLUEPRINT.md','docs/IMPLEMENTATION-PLAYBOOK.md','docs/USER-GUIDE.md','docs/PERFORMANCE-BUDGET.md','docs/REVIEW-GATES.md','manifests/PROJECT-STATE.json','manifests/ACCEPTANCE-CONTRACT.json','manifests/CACHE-PROVIDER-EVIDENCE.json','manifests/MIGRATION-MANIFEST.json','manifests/SOURCE-HASHES.json')
        foreach ($relative in $required) { if (-not (Test-Path -LiteralPath (Join-Path $rootPath $relative) -PathType Leaf)) { throw "missing $relative" } }
        $blueprints = @(Get-ChildItem -LiteralPath (Join-Path $rootPath 'docs') -File -Filter '*BLUEPRINT*.md')
        if ($blueprints.Count -ne 1 -or $blueprints[0].Name -ne 'PI-CODING-HARNESS-BLUEPRINT.md') { throw 'authoritative blueprint set is invalid' }
    }
    Push-Location $rootPath
    try {
        if (-not $SkipPerformance) { Invoke-Step 'performance' { & npm run verify:performance } }
        Invoke-Step 'compile' { & npm run compile }
        Invoke-Step 'lint' { & npm run lint }
        Invoke-Step 'build' { & npm run build }
        Invoke-Step 'tests' {
            & $vitest run --reporter=json "--outputFile=$testReportPath"
            $script:testSummary = Get-Content -LiteralPath $testReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $script:testSummary.success) { throw 'Vitest JSON summary did not report success' }
        }
        Invoke-Step 'sql' { & npm run verify:sql }
        Invoke-Step 'json' { & npm run verify:json }
        Invoke-Step 'markdown' { & npm run verify:markdown }
        Invoke-Step 'state-update' { & npm run verify:state-update }
        if (-not $SkipLifecycle) { Invoke-Step 'lifecycle' { & npm run verify:lifecycle } }
        Invoke-Step 'arbitrary-cwd-import' {
            $temp = Join-Path ([IO.Path]::GetTempPath()) ('pch-import-' + [guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($temp) | Out-Null
            try {
                Push-Location $temp
                try { & node --input-type=module -e "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[1]).href);" (Join-Path $rootPath 'dist\index.js') }
                finally { Pop-Location }
            } finally {
                $resolved = [IO.Path]::GetFullPath($temp)
                if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { [IO.Directory]::Delete($resolved, $true) }
            }
        }
        Invoke-Step 'self-contained' { & npm run verify:self-contained }
    } finally { Pop-Location }
} catch { }

$report = [ordered]@{
    schema_version = 1
    status = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL' }
    root = $rootPath
    elapsed_ms = $overall.ElapsedMilliseconds
    steps = $steps.ToArray()
    tests_observed = if ($testSummary) { [ordered]@{
        passed = [int]$testSummary.numPassedTests
        conditionally_skipped = [int]$testSummary.numPendingTests
        total = [int]$testSummary.numTotalTests
    } } else { $null }
    additional_model_requests = 0
    additional_provider_requests = 0
    failures = $failures.ToArray()
}
$json = ($report | ConvertTo-Json -Depth 20) + "`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), $json, (New-Object Text.UTF8Encoding($false)))
$json
if ($failures.Count) { exit 1 }
