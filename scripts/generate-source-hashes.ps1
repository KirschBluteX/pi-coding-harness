[CmdletBinding()]
param([string]$Root)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$manifestPath = Join-Path $rootPath 'manifests\MIGRATION-MANIFEST.json'
$outputPath = Join-Path $rootPath 'manifests\SOURCE-HASHES.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$excludedDirectories = @('node_modules', 'dist', '.tmp', 'reports', '.git')

function Get-SelectedFiles([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($excludedDirectories -contains $item.Name) { continue }
        if ($item.PSIsContainer) { Get-SelectedFiles $item.FullName }
        elseif ($item.Name -notlike '.MIGRATION-MANIFEST.tmp.*' -and $item.Name -notlike '.SOURCE-HASHES.tmp.*') { $item }
    }
}

$targetFiles = Get-SelectedFiles $rootPath | Where-Object {
    $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/')
    $relative -notin @('manifests\SOURCE-HASHES.json', 'manifests\PROJECT-STATE.json', 'PROJECT-STATUS.md')
} | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    [ordered]@{
        path = $relative
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        bytes = $_.Length
    }
}

$inputSources = $manifest.entries | Where-Object { $_.source_sha256 } | ForEach-Object {
    [ordered]@{
        migration_id = $_.id
        source = $_.source
        sha256 = $_.source_sha256
        disposition = $_.disposition
    }
}

$document = [ordered]@{
    '$schema' = '../schemas/source-hashes.schema.json'
    schema_version = 1
    generated_at = [DateTimeOffset]::Now.ToString('o')
    algorithm = 'SHA-256'
    target_root = '.'
    input_sources = @($inputSources)
    target_files = @($targetFiles)
}
$json = ($document | ConvertTo-Json -Depth 20) + "`n"
$temporary = Join-Path (Split-Path -Parent $outputPath) ('.SOURCE-HASHES.tmp.' + [guid]::NewGuid().ToString('N') + '.json')
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($temporary, $json, $utf8)
if (Test-Path -LiteralPath $outputPath) {
    $backup = Join-Path (Split-Path -Parent $outputPath) ('.SOURCE-HASHES.bak.' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::Replace($temporary, $outputPath, $backup, $true)
        if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) }
    } catch {
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
        throw
    }
} else {
    [IO.File]::Move($temporary, $outputPath)
}
[pscustomobject]@{ status = 'PASS'; files = @($targetFiles).Count; output = 'manifests/SOURCE-HASHES.json' } | ConvertTo-Json
