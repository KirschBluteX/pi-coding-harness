[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$Root,
    [string]$DataRoot = (Join-Path $HOME '.pi\agent\coding-harness'),
    [string]$ReportPath,
    [string]$ExportPath,
    [switch]$DeleteData,
    [switch]$SkipPiRegistration,
    [switch]$SkipRuntimeBuild
)
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
& (Join-Path $PSScriptRoot 'invoke-lifecycle.ps1') -Operation UNINSTALL -Root $Root -DataRoot $DataRoot `
    -ReportPath $ReportPath -ExportPath $ExportPath -DeleteData:$DeleteData `
    -SkipPiRegistration:$SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild -WhatIf:$WhatIfPreference
