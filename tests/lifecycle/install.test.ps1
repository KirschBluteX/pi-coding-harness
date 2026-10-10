[CmdletBinding()]
param([switch]$SkipRuntimeBuild)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$temp = Join-Path $tempBase ('pch-install-test-' + [guid]::NewGuid().ToString('N'))
try {
    if (-not $SkipRuntimeBuild) {
        & npm --prefix $root run build:runtime --silent
        if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }
    }
    $package = Join-Path $temp 'package'
    foreach ($directory in @('src', 'config', 'schemas')) {
        New-Item -ItemType Directory -Path (Join-Path $package $directory) -Force | Out-Null
    }
    foreach ($file in @('package.json', 'package-lock.json', 'src/index.ts', 'config/default.json')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $package $file)
    }
    Copy-Item -LiteralPath (Join-Path $root 'schemas/sql') -Destination (Join-Path $package 'schemas/sql') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $package 'dist') -Recurse
    $configuredData = Join-Path $temp 'configured-data'
    $configPath = Join-Path $package 'config/default.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $config.data.root = $configuredData
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    $configuredReport = Join-Path $temp 'configured-install.json'
    & (Join-Path $root 'scripts/install.ps1') -Root $package -ReportPath $configuredReport `
        -SkipPiRegistration -SkipRuntimeBuild -WhatIf
    $planned = Get-Content -LiteralPath $configuredReport -Raw | ConvertFrom-Json
    if ($planned.data_root -ne $configuredData) { throw 'Install did not honor config.data.root.' }
    if (Test-Path -LiteralPath $configuredData) { throw 'WhatIf created the configured data root.' }
    & (Join-Path $root 'scripts/install.ps1') -Root $package -ReportPath $configuredReport `
        -SkipPiRegistration -SkipRuntimeBuild
    if ((Get-Item -LiteralPath (Join-Path $configuredData 'install.key')).Length -ne 32) { throw 'Configured install key is missing.' }
    $doctorReport = Join-Path $temp 'configured-doctor.json'
    & (Join-Path $root 'scripts/doctor.ps1') -Root $package -ReportPath $doctorReport -SkipRuntimeBuild
    $doctor = Get-Content -LiteralPath $doctorReport -Raw | ConvertFrom-Json
    if ($doctor.status -ne 'PASS' -or $doctor.data_root -ne $configuredData) { throw 'Doctor used a different data root.' }
    $report = Join-Path $temp 'install.json'
    & (Join-Path $root 'scripts\install.ps1') -Root $package -DataRoot (Join-Path $temp 'data') -ReportPath $report `
        -SkipPiRegistration -SkipRuntimeBuild
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 exited $LASTEXITCODE" }
    $manifest = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.status -ne 'PASS') { throw "Install status $($manifest.status)" }
    if ((Get-Item -LiteralPath (Join-Path $temp 'data\install.key')).Length -ne 32) { throw 'Install key length is not 32.' }
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    if (-not $resolvedTemp.StartsWith($tempBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Test cleanup path is outside the temporary root.'
    }
    if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
}
