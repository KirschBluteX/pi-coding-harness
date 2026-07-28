[CmdletBinding()]
param([string]$Root, [switch]$SkipSourceVerification)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$statePath = Join-Path $rootPath 'manifests\PROJECT-STATE.json'
$sourcePath = Join-Path $rootPath 'manifests\SOURCE-HASHES.json'
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$mismatches = New-Object Collections.Generic.List[object]
$checked = 0
if (-not $SkipSourceVerification) {
    $manifest = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in @($manifest.target_files)) {
        $checked++
        $path = Join-Path $rootPath ([string]$entry.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $mismatches.Add([ordered]@{path=$entry.path;reason='MISSING'}); continue }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { $mismatches.Add([ordered]@{path=$entry.path;reason='HASH_MISMATCH'}) }
    }
}
$status = if ($mismatches.Count) { 'STALE_SOURCE_CLOSURE' } elseif (@($state.blockers).Count) { 'BLOCKED' } else { 'PASS' }
$result = [ordered]@{
    status = $status
    product = $state.product
    version = $state.version
    state_generation = $state.state_generation
    updated_at = $state.updated_at
    current_phase = $state.current_phase
    current_stage = $state.current_stage
    goal = $state.goal
    next_action = $state.next_action
    latest_correction = $state.latest_correction
    blockers = @($state.blockers)
    open_risks = @($state.open_risks | Select-Object -Last 5)
    do_not_repeat = @($state.do_not_repeat | Select-Object -Last 6)
    verification = $state.verification
    source_closure = [ordered]@{
        verification = if ($SkipSourceVerification) { 'SKIPPED_SAME_SLICE_ONLY' } else { 'FULL_MANIFEST' }
        files_checked = $checked
        mismatch_count = $mismatches.Count
        mismatches = @($mismatches | Select-Object -First 5)
    }
}
$result | ConvertTo-Json -Depth 10
if ($status -ne 'PASS') { exit 2 }
