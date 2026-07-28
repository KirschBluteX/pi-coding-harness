[CmdletBinding()]
param(
    [string]$Root,
    [string]$DataRoot = (Join-Path $HOME '.pi\agent\coding-harness'),
    [string]$ReportPath,
    [switch]$SkipRuntimeBuild
)
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
& (Join-Path $PSScriptRoot 'invoke-lifecycle.ps1') -Operation DOCTOR -Root $Root -DataRoot $DataRoot `
    -ReportPath $ReportPath -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild
