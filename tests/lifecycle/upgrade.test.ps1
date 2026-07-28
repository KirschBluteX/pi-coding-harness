[CmdletBinding()]
param([switch]$SkipRuntimeBuild)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ('pch-upgrade-test-' + [guid]::NewGuid().ToString('N'))
try {
    $workspace = Join-Path $temp 'data\workspaces\fixture'
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $db = Join-Path $workspace 'authority.sqlite'
    $migrationHash = (Get-FileHash -LiteralPath (Join-Path $root 'schemas\sql\001_core.sql') -Algorithm SHA256).Hash.ToLowerInvariant()
    $bootstrap = @'
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const d=new DatabaseSync(process.argv[1]);
d.exec(fs.readFileSync(process.argv[2],'utf8'));
d.prepare('INSERT INTO schema_migrations(version,name,sha256,applied_at_ms) VALUES(1,?,?,1)').run('001_core.sql',process.argv[3]);
d.prepare('INSERT INTO store_meta(singleton,store_id,schema_version,store_generation,leader_epoch,created_at_ms) VALUES(1,?,1,1,1,1)').run('STORE-PS');
d.close();
'@
    & node -e $bootstrap $db (Join-Path $root 'schemas\sql\001_core.sql') $migrationHash
    if ($LASTEXITCODE -ne 0) { throw 'N-1 fixture creation failed.' }
    $report = Join-Path $temp 'upgrade.json'
    & (Join-Path $root 'scripts\upgrade.ps1') -Root $root -DataRoot (Join-Path $temp 'data') -ReportPath $report `
        -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild
    if ($LASTEXITCODE -ne 0) { throw "upgrade.ps1 exited $LASTEXITCODE" }
    $manifest = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedMigrationVersion = Get-ChildItem -LiteralPath (Join-Path $root 'schemas\sql') -Filter '*.sql' |
        ForEach-Object { if ($_.BaseName -match '^(\d{3})_') { [int]$Matches[1] } } |
        Measure-Object -Maximum |
        Select-Object -ExpandProperty Maximum
    if ($manifest.status -ne 'PASS' -or
        $manifest.runtime_supported_migration_version -ne $expectedMigrationVersion -or
        $manifest.authorities[0].migrationVersion -ne $expectedMigrationVersion) {
        throw "N-1 upgrade did not reach supported schema $expectedMigrationVersion."
    }
    if (-not (Test-Path -LiteralPath $manifest.authorities[0].backupPath -PathType Leaf)) { throw 'Upgrade backup missing.' }
    $backupCount = @(Get-ChildItem -LiteralPath (Join-Path $temp 'data\backups') -File -Recurse).Count
    $currentReport = Join-Path $temp 'upgrade-current.json'
    & (Join-Path $root 'scripts\upgrade.ps1') -Root $root -DataRoot (Join-Path $temp 'data') `
        -ReportPath $currentReport -SkipPiRegistration -SkipRuntimeBuild:$SkipRuntimeBuild
    if ($LASTEXITCODE -ne 0) { throw "current-schema upgrade.ps1 exited $LASTEXITCODE" }
    $current = Get-Content -LiteralPath $currentReport -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($current.status -ne 'PASS' -or $null -ne $current.authorities[0].backupPath) {
        throw 'Current-schema upgrade did not take the verified no-backup path.'
    }
    if ($current.actions.code -contains 'BACKUP_AUTHORITY') { throw 'Current-schema upgrade planned a redundant backup.' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $temp 'data\backups') -File -Recurse).Count -ne $backupCount) {
        throw 'Current-schema upgrade created a redundant backup file.'
    }
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
