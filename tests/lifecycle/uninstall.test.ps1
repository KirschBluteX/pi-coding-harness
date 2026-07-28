[CmdletBinding()]
param([switch]$SkipRuntimeBuild)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('pch-uninstall-test-' + [guid]::NewGuid().ToString('N'))
try {
    $data = Join-Path $temp 'data'
    & (Join-Path $root 'scripts\install.ps1') -Root $root -DataRoot $data -ReportPath (Join-Path $temp 'install.json') `
        -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild | Out-Null
    Set-Content -LiteralPath (Join-Path $data 'retained.txt') -Value 'authority fixture' -Encoding UTF8
    & (Join-Path $root 'scripts\uninstall.ps1') -Root $root -DataRoot $data -ReportPath (Join-Path $temp 'preserve.json') `
        -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild | Out-Null
    if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw 'Default uninstall deleted data.' }
    $export = Join-Path $temp 'export'
    & (Join-Path $root 'scripts\uninstall.ps1') -Root $root -DataRoot $data -ReportPath (Join-Path $temp 'delete.json') `
        -ExportPath $export -DeleteData -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild -Confirm:$false | Out-Null
    if (Test-Path -LiteralPath $data) { throw 'Explicit uninstall did not delete data.' }
    if (-not (Test-Path -LiteralPath (Join-Path $export 'retained.txt') -PathType Leaf)) { throw 'Export did not retain data.' }

    $foreign = Join-Path $temp 'foreign-data'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $foreign 'install.key'), (New-Object byte[] 32))
    Set-Content -LiteralPath (Join-Path $foreign 'retained.txt') -Value 'must survive' -Encoding UTF8
    $rejected = $false
    try {
        & (Join-Path $root 'scripts\uninstall.ps1') -Root $root -DataRoot $foreign `
            -ReportPath (Join-Path $temp 'foreign-delete.json') -DeleteData -SkipPiRegistration `
            -SkipRuntimeBuild:$SkipRuntimeBuild -Confirm:$false | Out-Null
    } catch { $rejected = $true }
    if (-not $rejected) { throw 'Uninstall accepted a foreign directory with a spoof install key.' }
    if (-not (Test-Path -LiteralPath (Join-Path $foreign 'retained.txt') -PathType Leaf)) {
        throw 'Rejected foreign directory was modified.'
    }
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
