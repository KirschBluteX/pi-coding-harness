[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][ValidateSet('INSTALL','DOCTOR','UPGRADE','UNINSTALL')][string]$Operation,
    [string]$Root,
    [string]$DataRoot = (Join-Path $HOME '.pi\agent\coding-harness'),
    [string]$ReportPath,
    [string]$ExportPath,
    [switch]$DeleteData,
    [switch]$SkipPiRegistration,
    [switch]$SkipRuntimeBuild
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
if (-not $ReportPath) {
    $stamp = [DateTimeOffset]::Now.ToString('yyyyMMddTHHmmssfff')
    $ReportPath = Join-Path $rootPath "reports\lifecycle-$($Operation.ToLowerInvariant())-$stamp.json"
}
$reportFullPath = [IO.Path]::GetFullPath($ReportPath)

if (-not $SkipRuntimeBuild) {
    & npm --prefix $rootPath run build:runtime --silent
    if ($LASTEXITCODE -ne 0) { throw "PCH runtime build failed with exit code $LASTEXITCODE." }
}

$arguments = @(
    (Join-Path $rootPath 'dist\runtime\lifecycle.js'), $Operation,
    '--package-root', $rootPath, '--data-root', [IO.Path]::GetFullPath($DataRoot), '--report', $reportFullPath
)
if ($WhatIfPreference) { $arguments += '--what-if' }
if ($ExportPath) { $arguments += @('--export', [IO.Path]::GetFullPath($ExportPath)) }
if ($DeleteData) { $arguments += '--delete-data' }

& node @arguments
$lifecycleExit = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $reportFullPath)) { throw 'Lifecycle manifest was not produced.' }
$manifest = Get-Content -LiteralPath $reportFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($lifecycleExit -ne 0 -or $manifest.status -in @('FAIL','BLOCKED')) {
    throw "PCH lifecycle $Operation $($manifest.status): $($manifest.failures -join '; ')"
}

if (-not $WhatIfPreference -and -not $SkipPiRegistration -and $manifest.registration_command) {
    $piCommand = Get-Command pi -ErrorAction Stop
    $piArgs = @($manifest.registration_command | Select-Object -Skip 1)
    if ($PSCmdlet.ShouldProcess(($piArgs -join ' '), 'Invoke Pi package lifecycle command')) {
        & $piCommand.Source @piArgs
        if ($LASTEXITCODE -ne 0) { throw "Pi package registration command failed with exit code $LASTEXITCODE." }
    }
}

if (-not $WhatIfPreference -and $Operation -eq 'UNINSTALL') {
    $resolvedDataRoot = [IO.Path]::GetFullPath($manifest.data_root).TrimEnd('\', '/')
    if ($ExportPath) {
        $resolvedExport = [IO.Path]::GetFullPath($ExportPath).TrimEnd('\', '/')
        if ($resolvedExport.StartsWith($resolvedDataRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $resolvedDataRoot.StartsWith($resolvedExport + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $resolvedExport -eq $resolvedDataRoot) {
            throw 'Export path and data root cannot contain one another.'
        }
        if (Test-Path -LiteralPath $resolvedExport) { throw "Export destination already exists: $resolvedExport" }
        if (Test-Path -LiteralPath $resolvedDataRoot) {
            Copy-Item -LiteralPath $resolvedDataRoot -Destination $resolvedExport -Recurse -ErrorAction Stop
        }
    }
    if ($DeleteData) {
        $marker = Join-Path $resolvedDataRoot 'install.key'
        $ownershipMarker = Join-Path $resolvedDataRoot 'install.marker.json'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
            -not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)) {
            throw 'Refusing data deletion without the PCH ownership marker.'
        }
        $resolvedMarker = [IO.Path]::GetFullPath($marker)
        if (-not $resolvedMarker.StartsWith($resolvedDataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'PCH install marker resolves outside the data root.'
        }
        if ($PSCmdlet.ShouldProcess($resolvedDataRoot, 'Delete Pi Coding Harness authority, CAS, and install key')) {
            Remove-Item -LiteralPath $resolvedDataRoot -Recurse -Force -ErrorAction Stop
        }
    }
}

$manifest
