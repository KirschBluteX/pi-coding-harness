[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Root,
    [string]$DataRoot = (Join-Path $HOME '.pi\agent\coding-harness'),
    [string]$ReportPath,
    [switch]$SkipPiRegistration,
    [switch]$SkipRuntimeBuild
)
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
& (Join-Path $PSScriptRoot 'invoke-lifecycle.ps1') -Operation UPGRADE -Root $Root -DataRoot $DataRoot `
    -ReportPath $ReportPath -SkipPiRegistration:$SkipPiRegistration `
    -SkipRuntimeBuild:$SkipRuntimeBuild -WhatIf:$WhatIfPreference
