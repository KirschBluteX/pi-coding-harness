[CmdletBinding()]
param([string]$Root, [string]$ReportPath)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$package = Get-Content -LiteralPath (Join-Path $rootPath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$excludedSegments = @($package.codingHarness.releaseExcludedDirectories)
$excludedFiles = @($package.codingHarness.releaseExcludedFiles)
if ($excludedSegments.Count -eq 0 -or @($excludedSegments | Where-Object {
    -not ($_ -is [string]) -or -not $_ -or $_ -match '\\' -or
    $_.StartsWith('/') -or $_.EndsWith('/') -or $_ -match '(^|/)\.\.?($|/)' -or $_ -match '//'
}).Count -gt 0) { throw 'package.json releaseExcludedDirectories is invalid.' }
if ($excludedFiles.Count -eq 0 -or @($excludedFiles | Where-Object {
    -not ($_ -is [string]) -or -not $_ -or $_ -match '[/\\]'
}).Count -gt 0) { throw 'package.json releaseExcludedFiles is invalid.' }
if (-not $ReportPath) { $ReportPath = Join-Path $rootPath 'reports\self-contained.json' }
$failures = New-Object System.Collections.Generic.List[string]

$required = @(
    'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'PROJECT-STATUS.md',
    'package.json', 'package-lock.json', '.gitignore',
    'docs/PI-CODING-HARNESS-BLUEPRINT.md', 'docs/IMPLEMENTATION-PLAYBOOK.md', 'docs/USER-GUIDE.md',
    'docs/PERFORMANCE-BUDGET.md', 'docs/REVIEW-GATES.md', 'manifests/PROJECT-STATE.json',
    'manifests/ACCEPTANCE-CONTRACT.json', 'manifests/MIGRATION-MANIFEST.json', 'manifests/SOURCE-HASHES.json',
    'scripts/generate-migration-manifest.ps1', 'scripts/generate-source-hashes.ps1', 'scripts/validate-json.mjs',
    'scripts/verify-project.ps1', 'scripts/verify-self-contained.ps1', 'scripts/verify-performance-baseline.ps1',
    'schemas/migration-manifest.schema.json', 'schemas/source-hashes.schema.json',
    'schemas/sql/001_core.sql', 'schemas/sql/017_target_performance_receipts.sql',
    'schemas/sql/018_control_plane_v2.sql', 'schemas/sql/019_patch_transaction_v1.sql',
    'schemas/sql/034_dynamic_multi_proposal_v2.sql', 'schemas/sql/035_session_goal_binding_v1.sql', 'src/index.ts',
    'src/artifacts/artifact-store.ts', 'src/output/response-contract.ts'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $rootPath $relative) -PathType Leaf)) { $failures.Add("Missing required file: $relative") }
}

$gitignorePath = Join-Path $rootPath '.gitignore'
$gitignoreLines = @(Get-Content -LiteralPath $gitignorePath -Encoding UTF8 | ForEach-Object { $_.Trim() })
foreach ($unsafe in @('node_modules/', 'dist/', 'coverage/', '.cache/', '.coding-harness/', 'artifacts/', 'telemetry/', 'reports/', '.tmp/', 'tmp/')) {
    if ($gitignoreLines -contains $unsafe) { $failures.Add("Unanchored root runtime ignore can hide source Modules: $unsafe") }
}

$blueprints = @(Get-ChildItem -LiteralPath (Join-Path $rootPath 'docs') -File -Filter '*BLUEPRINT*.md')
if ($blueprints.Count -ne 1 -or $blueprints[0].Name -ne 'PI-CODING-HARNESS-BLUEPRINT.md') {
    $failures.Add('Exactly one authoritative blueprint must exist.')
}
$oldAcronym = -join ([char]80, [char]71, [char]82)
$oldAcronymLower = $oldAcronym.ToLowerInvariant()
foreach ($obsolete in @('.' + $oldAcronymLower, '.pi-' + 'goal-' + 'runtime', 'docs\references')) {
    if (Test-Path -LiteralPath (Join-Path $rootPath $obsolete)) { $failures.Add("Obsolete path exists: $obsolete") }
}

function Get-ReleaseItems([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop) {
        if ($item.PSIsContainer -and (Test-ExcludedDirectory $item.FullName)) { continue }
        if (-not $item.PSIsContainer -and (Test-ExcludedFile $item.Name)) { continue }
        $item
        if ($item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            Get-ReleaseItems $item.FullName
        }
    }
}

function Test-ExcludedFile([string]$Name) {
    foreach ($pattern in $excludedFiles) {
        if ($Name -like $pattern) { return $true }
    }
    return $false
}

function Test-ExcludedDirectory([string]$FullName) {
    $relative = $FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    return $excludedSegments -contains $relative
}
$releaseItems = @(Get-ReleaseItems $rootPath)
$files = @($releaseItems | Where-Object { -not $_.PSIsContainer })
$reparse = @($releaseItems | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
foreach ($item in $reparse) { $failures.Add("Reparse point in release closure: $($item.FullName)") }

$forbiddenFiles = @($files | Where-Object {
    ($_.Name -like '.env*' -and $_.Name -notin @('.env.example', '.env.sample', '.env.template')) -or
    $_.Extension -in @('.sqlite', '.sqlite3', '.log', '.pem', '.key', '.pfx') -or
    $_.Name -like '*.sqlite*-wal' -or $_.Name -like '*.sqlite*-shm'
})
foreach ($item in $forbiddenFiles) { $failures.Add("Generated or sensitive file: $($item.FullName)") }

$oldProduct = 'Pi ' + 'Goal ' + 'Runtime'
$oldCommand = '/' + 'goal'
$oldCommandPattern = (('(^|[\s"{0}{1}])' -f [char]39, [char]96) + [regex]::Escape($oldCommand) + '(?![A-Za-z0-9_-])')
$textExtensions = @('.ts', '.mjs', '.ps1', '.py', '.json', '.md', '.sql', '.txt')
foreach ($file in $files | Where-Object { $textExtensions -contains $_.Extension }) {
    $relative = $file.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    if ($relative -in @('manifests/MIGRATION-MANIFEST.json', 'manifests/SOURCE-HASHES.json')) { continue }
    $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    $hasOldAcronym = [regex]::IsMatch($content, "(?<![A-Za-z0-9])$oldAcronym(?![A-Za-z0-9])", [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $hasOldCommand = [regex]::IsMatch($content, $oldCommandPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::Multiline)
    if ($content.Contains($oldProduct) -or $hasOldAcronym -or $hasOldCommand) {
        $failures.Add("Obsolete public identity in active file: $relative")
    }
}

$runtimeText = Get-ChildItem -LiteralPath (Join-Path $rootPath 'src') -Recurse -File -Filter '*.ts' |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 }
if (($runtimeText -join "`n") -match '\b(setModel|setThinkingLevel)\s*\(') {
    $failures.Add('Runtime attempts to change model or thinking level.')
}

$hashManifest = Get-Content -LiteralPath (Join-Path $rootPath 'manifests\SOURCE-HASHES.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hashMismatches = 0
foreach ($entry in @($hashManifest.target_files)) {
    $path = Join-Path $rootPath ([string]$entry.path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { $hashMismatches++ }
}
if ($hashMismatches) { $failures.Add("Source hash mismatches: $hashMismatches") }

$migration = Get-Content -LiteralPath (Join-Path $rootPath 'manifests\MIGRATION-MANIFEST.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$migrationMismatches = 0
foreach ($entry in @($migration.entries | Where-Object { $_.destination -and $_.destination_sha256 })) {
    $path = Join-Path $rootPath ([string]$entry.destination)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.destination_sha256) { $migrationMismatches++ }
}
if ($migrationMismatches) { $failures.Add("Migration destination hash mismatches: $migrationMismatches") }
$stateProjectionEntries = @($migration.entries | Where-Object { $_.destination -in @('manifests/PROJECT-STATE.json', 'PROJECT-STATUS.md') })
if ($stateProjectionEntries.Count -ne 2 -or @($stateProjectionEntries | Where-Object {
    $_.disposition -ne 'REWRITTEN' -or $_.source_sha256 -ne $null -or $_.destination_sha256 -ne $null
}).Count -ne 0) {
    $failures.Add('Development state projections must be rewritten without source or destination hashes to prevent a manifest self-reference.')
}

$result = [ordered]@{
    status = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL' }
    root = $rootPath
    files_scanned = $files.Count
    blueprint_count = $blueprints.Count
    reparse_points = $reparse.Count
    forbidden_files = $forbiddenFiles.Count
    source_hash_mismatches = $hashMismatches
    migration_hash_mismatches = $migrationMismatches
    failures = @($failures)
}
[IO.Directory]::CreateDirectory((Split-Path -Parent ([IO.Path]::GetFullPath($ReportPath)))) | Out-Null
$json = ($result | ConvertTo-Json -Depth 20) + "`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), $json, (New-Object Text.UTF8Encoding($false)))
$json
if ($failures.Count) { exit 1 }
