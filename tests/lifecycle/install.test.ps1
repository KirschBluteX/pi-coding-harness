[CmdletBinding()]
param([switch]$SkipRuntimeBuild)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('pch-install-test-' + [guid]::NewGuid().ToString('N'))
try {
    $report = Join-Path $temp 'install.json'
    & (Join-Path $root 'scripts\install.ps1') -Root $root -DataRoot (Join-Path $temp 'data') -ReportPath $report `
        -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 exited $LASTEXITCODE" }
    $manifest = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.status -ne 'PASS') { throw "Install status $($manifest.status)" }
    if ((Get-Item -LiteralPath (Join-Path $temp 'data\install.key')).Length -ne 32) { throw 'Install key length is not 32.' }
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
