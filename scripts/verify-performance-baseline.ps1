[CmdletBinding()]
param([string]$Root, [string]$ReportPath, [string]$PerformanceDataRoot)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
if (-not $ReportPath) { $ReportPath = Join-Path $rootPath 'reports\performance-summary.json' }
$reportDir = Split-Path -Parent ([IO.Path]::GetFullPath($ReportPath))
[IO.Directory]::CreateDirectory($reportDir) | Out-Null

$budgetPath = Join-Path $rootPath 'docs\PERFORMANCE-BUDGET.md'
$budgetText = Get-Content -LiteralPath $budgetPath -Raw -Encoding UTF8
$required = @('P50', 'P95', 'inactive hook', 'DirectCell', 'Memory v3', 'Input Context', 'Cache C1', 'C0 fallback', 'Target-project')
$missing = @($required | Where-Object { $budgetText.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -lt 0 })
$failures = New-Object System.Collections.Generic.List[string]
foreach ($item in $missing) { $failures.Add("Performance budget missing dimension: $item") }

$vitest = Join-Path $rootPath 'node_modules\.bin\vitest.cmd'
if (-not (Test-Path -LiteralPath $vitest -PathType Leaf)) { $failures.Add('Vitest is missing; run npm ci first.') }
$declaredDataRoot = if ($PerformanceDataRoot) {
    $PerformanceDataRoot
} elseif ($env:PCH_PERFORMANCE_DATA_ROOT) {
    $env:PCH_PERFORMANCE_DATA_ROOT
} elseif ($env:PCH_DATA_ROOT) {
    $env:PCH_DATA_ROOT
} else {
    Join-Path $HOME '.pi\agent\coding-harness'
}
$declaredDataRoot = [IO.Path]::GetFullPath($declaredDataRoot)
$declaredVolumeRoot = [IO.Path]::GetPathRoot($declaredDataRoot)
if (-not $declaredVolumeRoot) { throw 'Performance data root must resolve to a local volume.' }

# Benchmark an isolated sibling on the deployment data-root volume. Process TEMP may
# be on a different disk and is therefore not authoritative performance evidence.
$performanceAnchor = Split-Path -Parent $declaredDataRoot
if (-not $performanceAnchor) { $performanceAnchor = $declaredVolumeRoot }
while (-not (Test-Path -LiteralPath $performanceAnchor -PathType Container)) {
    $parent = Split-Path -Parent $performanceAnchor
    if (-not $parent -or $parent -eq $performanceAnchor) { throw 'No existing ancestor for the performance data root.' }
    $performanceAnchor = $parent
}
$tempRoot = Join-Path $performanceAnchor ('.pch-performance-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetPathRoot($tempRoot).Equals($declaredVolumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Performance epoch is not on the declared data-root volume.'
}
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$previous = @{
    PCH_PHASE1_PERFORMANCE = $env:PCH_PHASE1_PERFORMANCE
    PCH_TASK_FLOW_PERFORMANCE = $env:PCH_TASK_FLOW_PERFORMANCE
    PCH_MEMORY_V3_PERFORMANCE = $env:PCH_MEMORY_V3_PERFORMANCE
    PCH_CACHE_V2_PERFORMANCE = $env:PCH_CACHE_V2_PERFORMANCE
    PCH_PERFORMANCE_DATA_ROOT = $env:PCH_PERFORMANCE_DATA_ROOT
}
$commands = @()
try {
    $env:PCH_PHASE1_PERFORMANCE = '1'
    $env:PCH_TASK_FLOW_PERFORMANCE = '1'
    $env:PCH_MEMORY_V3_PERFORMANCE = '1'
    $env:PCH_CACHE_V2_PERFORMANCE = '1'
    $env:PCH_PERFORMANCE_DATA_ROOT = $tempRoot
    if ($failures.Count -eq 0) {
        foreach ($file in @('tests/performance/phase-1.test.ts', 'tests/performance/task-flow.test.ts', 'tests/performance/memory-v3.test.ts', 'tests/performance/cache-v2.test.ts')) {
            Push-Location $rootPath
            try { & $vitest run $file --no-file-parallelism --reporter=dot } finally { Pop-Location }
            $commands += [ordered]@{ command = "vitest run $file"; exit_code = $LASTEXITCODE }
            if ($LASTEXITCODE -ne 0) { $failures.Add("Performance test failed: $file"); break }
        }
    }
} finally {
    $env:PCH_PHASE1_PERFORMANCE = $previous.PCH_PHASE1_PERFORMANCE
    $env:PCH_TASK_FLOW_PERFORMANCE = $previous.PCH_TASK_FLOW_PERFORMANCE
    $env:PCH_MEMORY_V3_PERFORMANCE = $previous.PCH_MEMORY_V3_PERFORMANCE
    $env:PCH_CACHE_V2_PERFORMANCE = $previous.PCH_CACHE_V2_PERFORMANCE
    $env:PCH_PERFORMANCE_DATA_ROOT = $previous.PCH_PERFORMANCE_DATA_ROOT
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    $resolvedAnchor = [IO.Path]::GetFullPath($performanceAnchor).TrimEnd('\', '/')
    $tempParent = (Split-Path -Parent $resolvedTemp).TrimEnd('\', '/')
    $tempName = Split-Path -Leaf $resolvedTemp
    if (-not $tempParent.Equals($resolvedAnchor, [StringComparison]::OrdinalIgnoreCase) -or
        -not $tempName.StartsWith('.pch-performance-', [StringComparison]::Ordinal)) {
        throw 'Refusing to clean an unbound performance epoch.'
    }
    if (Test-Path -LiteralPath $resolvedTemp) { [IO.Directory]::Delete($resolvedTemp, $true) }
}

$evidence = @()
foreach ($name in @('phase-1-performance.json', 'task-flow-v1-performance.json', 'memory-v3-performance.json', 'cache-v2-performance.json')) {
    $path = Join-Path $rootPath ('reports\' + $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $failures.Add("Missing performance evidence: $name"); continue }
    $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($value.status -ne 'PASS') { $failures.Add("Performance evidence is not PASS: $name") }
    $evidence += [ordered]@{ path = "reports/$name"; status = $value.status; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
}

$result = [ordered]@{
    status = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL' }
    scope = 'PCH local overhead only; provider and target-project effects are not measured by this command.'
    deployment_data_root = $declaredDataRoot
    deployment_volume_root = $declaredVolumeRoot
    performance_epoch_root = $tempRoot
    commands = $commands
    evidence = $evidence
    additional_model_requests = 0
    additional_provider_requests = 0
    failures = @($failures)
}
$json = ($result | ConvertTo-Json -Depth 20) + "`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), $json, (New-Object Text.UTF8Encoding($false)))
$json
if ($failures.Count) { exit 1 }
