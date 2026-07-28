[CmdletBinding()]
param([string]$Root)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$outputPath = Join-Path $rootPath 'manifests\MIGRATION-MANIFEST.json'
$excludedDirectories = @('node_modules', 'dist', '.tmp', 'reports', '.git')
$deferredFiles = @(
    'manifests/MIGRATION-MANIFEST.json',
    'manifests/SOURCE-HASHES.json',
    'manifests/PROJECT-STATE.json',
    'PROJECT-STATUS.md'
)
$entries = [Collections.Generic.List[object]]::new()
$sequence = 0

function Get-SelectedFiles([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($excludedDirectories -contains $item.Name) { continue }
        if ($item.PSIsContainer) { Get-SelectedFiles $item.FullName }
        elseif ($item.Name -notlike '.MIGRATION-MANIFEST.tmp.*' -and $item.Name -notlike '.SOURCE-HASHES.tmp.*') { $item }
    }
}

function Add-Entry([hashtable]$Values) {
    $script:sequence++
    $entry = [ordered]@{ id = 'MIG-{0:D3}' -f $script:sequence }
    foreach ($key in @('source','destination','source_sha256','destination_sha256','category','purpose','disposition','rewritten','reason')) {
        $entry[$key] = $Values[$key]
    }
    $script:entries.Add($entry)
}

function Get-Category([string]$Relative) {
    if ($Relative -eq 'docs/PI-CODING-HARNESS-BLUEPRINT.md') { return 'BLUEPRINT' }
    if ($Relative -eq 'manifests/CACHE-PROVIDER-EVIDENCE.json') { return 'RUNTIME_EVIDENCE' }
    if ($Relative.StartsWith('docs/')) { return 'ARCHITECTURE_REPORT' }
    if ($Relative.StartsWith('schemas/')) { return 'SCHEMA_REFERENCE' }
    if ($Relative.StartsWith('LICENSES/') -or $Relative -eq 'LICENSE') { return 'LICENSE' }
    if ($Relative.StartsWith('tests/') -or $Relative.StartsWith('fixtures/') -or $Relative.StartsWith('scripts/verify-')) { return 'VALIDATION' }
    if ($Relative.StartsWith('src/') -or $Relative.StartsWith('scripts/')) { return 'CODE' }
    if ($Relative -in @('package.json','package-lock.json')) { return 'DEPENDENCY_TREE' }
    return 'CODE'
}

$files = Get-SelectedFiles $rootPath | Where-Object {
    $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    $deferredFiles -notcontains $relative
} | Sort-Object FullName

foreach ($file in $files) {
    $relative = $file.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    Add-Entry @{
        source = $file.FullName
        destination = $relative
        source_sha256 = $digest
        destination_sha256 = $digest
        category = Get-Category $relative
        purpose = 'Required self-contained release closure.'
        disposition = 'COPIED'
        rewritten = $false
        reason = 'Copied byte-for-byte into the renamed release root.'
    }
}

foreach ($relative in @('manifests/PROJECT-STATE.json', 'PROJECT-STATUS.md')) {
    $source = Join-Path $rootPath $relative
    Add-Entry @{
        source = $source
        destination = $relative
        source_sha256 = $null
        destination_sha256 = $null
        category = 'RUN_ARTIFACT'
        purpose = 'Development recovery state finalized after release verification.'
        disposition = 'REWRITTEN'
        rewritten = $true
        reason = 'Final verification and artifact hashes are written after migration; both directions omit hashes to prevent a transitive self-reference.'
    }
}

foreach ($relative in @('manifests/MIGRATION-MANIFEST.json', 'manifests/SOURCE-HASHES.json')) {
    Add-Entry @{
        source = 'generated:' + $relative
        destination = $relative
        source_sha256 = $null
        destination_sha256 = $null
        category = 'VALIDATION'
        purpose = 'Generated release provenance and integrity evidence.'
        disposition = 'GENERATED'
        rewritten = $false
        reason = 'Generated from the final selected closure; self-referential hashes are intentionally prohibited.'
    }
}

foreach ($directory in $excludedDirectories) {
    Add-Entry @{
        source = Join-Path $rootPath $directory
        destination = $null
        source_sha256 = $null
        destination_sha256 = $null
        category = $(if ($directory -eq 'node_modules') { 'DEPENDENCY_TREE' } else { 'RUN_ARTIFACT' })
        purpose = 'Excluded generated, dependency, report or version-control tree.'
        disposition = 'EXCLUDED'
        rewritten = $false
        reason = 'Recreated or intentionally absent in the clean target; not part of the self-contained source closure.'
    }
}

$document = [ordered]@{
    '$schema' = '../schemas/migration-manifest.schema.json'
    schema_version = 1
    generated_at = [DateTimeOffset]::Now.ToString('o')
    target_root = '.'
    selection_policy = 'Project-owned source, tests, schemas, current documentation, lifecycle scripts and license evidence are copied; dependencies, build output, reports, runtime state and version-control metadata are excluded.'
    entries = $entries.ToArray()
    summary = [ordered]@{
        candidate_count = $entries.Count
        copied_count = @($entries | Where-Object disposition -eq 'COPIED').Count
        rewritten_count = @($entries | Where-Object disposition -eq 'REWRITTEN').Count
        generated_count = @($entries | Where-Object disposition -eq 'GENERATED').Count
        excluded_count = @($entries | Where-Object disposition -eq 'EXCLUDED').Count
    }
}

[IO.Directory]::CreateDirectory((Split-Path -Parent $outputPath)) | Out-Null
$temporary = Join-Path (Split-Path -Parent $outputPath) ('.MIGRATION-MANIFEST.tmp.' + [guid]::NewGuid().ToString('N') + '.json')
$json = ($document | ConvertTo-Json -Depth 20) + "`n"
[IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
if (Test-Path -LiteralPath $outputPath) {
    $backup = $temporary + '.bak'
    try { [IO.File]::Replace($temporary, $outputPath, $backup, $true) }
    finally { if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) } }
} else { [IO.File]::Move($temporary, $outputPath) }

[pscustomobject]@{ status = 'PASS'; entries = $entries.Count; output = 'manifests/MIGRATION-MANIFEST.json' } | ConvertTo-Json
