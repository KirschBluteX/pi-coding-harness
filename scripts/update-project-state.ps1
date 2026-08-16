[CmdletBinding()]
param([string]$Root, [string]$PatchJsonPath, [switch]$RegenerateOnly)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
$statePath = Join-Path $rootPath 'manifests\PROJECT-STATE.json'
$statusPath = Join-Path $rootPath 'PROJECT-STATUS.md'
$package = Get-Content -LiteralPath (Join-Path $rootPath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedAuthoritySchema = [int]$package.codingHarness.authoritySchema
if ($expectedAuthoritySchema -lt 1) { throw 'package.json authority schema is invalid.' }
$utf8 = New-Object Text.UTF8Encoding($false)

function Write-Atomic([string]$Path, [string]$Content) {
    $temporary = Join-Path (Split-Path -Parent $Path) ('.' + [IO.Path]::GetFileName($Path) + '.tmp.' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($temporary, $Content, $utf8)
    if (Test-Path -LiteralPath $Path) {
        $backup = $temporary + '.bak'
        try { [IO.File]::Replace($temporary, $Path, $backup, $true) } finally { if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) } }
    } else { [IO.File]::Move($temporary, $Path) }
}

function Unique-Append([object[]]$Existing, [object[]]$Incoming, [scriptblock]$Identity) {
    $result = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($item in @($Existing) + @($Incoming)) {
        $key = & $Identity $item
        if (-not $key) { throw 'Appended state item has no identity.' }
        $body = $item | ConvertTo-Json -Compress -Depth 20
        if ($seen.ContainsKey($key)) { if ($seen[$key] -ne $body) { throw "Conflicting state identity: $key" }; continue }
        $seen[$key] = $body
        $result.Add($item)
    }
    return $result.ToArray()
}

function Assert-Receipt($Receipt) {
    $keys = @($Receipt.PSObject.Properties.Name)
    foreach ($key in @('id','result','evidence')) {
        if ($keys -notcontains $key) { throw "Completed receipt missing $key" }
    }
    $unexpected = @($keys | Where-Object { $_ -notin @('id','result','evidence') })
    if ($unexpected.Count -gt 0) { throw "Completed receipt has unexpected property: $($unexpected[0])" }
    if (-not [string]$Receipt.id -or ([string]$Receipt.id).Length -gt 256) { throw 'Completed receipt id is invalid.' }
    if ($Receipt.result -notin @('PASS','FAIL','EXTERNAL_LIMIT')) { throw "Completed receipt $($Receipt.id) result is invalid." }
    if (-not [string]$Receipt.evidence -or ([string]$Receipt.evidence).Length -gt 8192) {
        throw "Completed receipt $($Receipt.id) evidence is invalid."
    }
}

function Assert-State($State) {
    $required = @('schema_version','product','version','authority_schema','status','state_generation','current_phase','current_stage','updated_at','goal','completed_receipts','authoritative_artifacts','decisions','latest_correction','failed_routes','do_not_repeat','open_risks','blockers','next_action','verification')
    foreach ($key in $required) { if ($State.PSObject.Properties.Name -notcontains $key) { throw "State missing $key" } }
    if ($State.schema_version -ne 1 -or $State.product -ne 'Pi Coding Harness' -or $State.authority_schema -ne $expectedAuthoritySchema) { throw 'State identity is invalid.' }
    if ($State.status -notin @('IMPLEMENTING','VERIFYING','PASS','FAIL','BLOCKED')) { throw 'State status is invalid.' }
    if ([int]$State.state_generation -lt 1 -or -not [string]$State.next_action) { throw 'State generation or next action is invalid.' }
    foreach ($receipt in @($State.completed_receipts)) { Assert-Receipt $receipt }
    foreach ($artifact in @($State.authoritative_artifacts)) {
        if ([string]$artifact.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "Artifact hash is invalid: $($artifact.path)" }
    }
    $verification = $State.verification
    $verificationKeys = @('result','commands','tests_passed','tests_skipped','report_sha256')
    if ($null -eq $verification) { throw 'State verification is missing.' }
    $actualVerificationKeys = @($verification.PSObject.Properties.Name)
    foreach ($key in $verificationKeys) {
        if ($actualVerificationKeys -notcontains $key) { throw "State verification missing $key" }
    }
    $unexpectedVerificationKeys = @($actualVerificationKeys | Where-Object { $verificationKeys -notcontains $_ })
    if ($unexpectedVerificationKeys.Count -gt 0) { throw "State verification has unexpected property: $($unexpectedVerificationKeys[0])" }
    if ($verification.result -notin @('NOT_RUN','PASS','FAIL')) { throw 'State verification result is invalid.' }
    if ($verification.commands -isnot [array]) { throw 'State verification commands must be an array.' }
    foreach ($command in @($verification.commands)) {
        if (-not ($command -is [string]) -or -not $command -or $command.Length -gt 1024) { throw 'State verification command is invalid.' }
    }
    foreach ($countKey in @('tests_passed','tests_skipped')) {
        $count = $verification.$countKey
        if ($count -isnot [byte] -and $count -isnot [int16] -and $count -isnot [int32] -and $count -isnot [int64]) {
            throw "State verification $countKey must be an integer."
        }
        if ([int64]$count -lt 0) { throw "State verification $countKey is invalid." }
    }
    if ($null -ne $verification.report_sha256 -and [string]$verification.report_sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'State verification report_sha256 is invalid.'
    }
}

function Render-Status($State) {
    $lines = @(
        '# Project status', '',
        '> Checked development projection; product authority remains SQLite/CAS.', '',
        "- Product: $($State.product)", "- Version: $($State.version)", "- Authority schema: $($State.authority_schema)",
        "- State: $($State.status)", "- Current phase: $($State.current_phase)", "- Current stage: $($State.current_stage)",
        "- State generation: $($State.state_generation)", "- Updated: $($State.updated_at)", '',
        '## Goal', '', [string]$State.goal, '', '## Evidence', '',
        "- Completed receipts: $(@($State.completed_receipts).Count)",
        "- Authoritative artifacts: $(@($State.authoritative_artifacts).Count)",
        "- Verification: $($State.verification.result)", '', '## Latest correction', '',
        $(if ($State.latest_correction) { "$($State.latest_correction.id): $($State.latest_correction.summary)" } else { 'None.' }), '',
        '## Do not repeat', ''
    )
    if (@($State.do_not_repeat).Count) { $lines += @($State.do_not_repeat | ForEach-Object { "- $_" }) } else { $lines += '- None.' }
    $lines += @('', '## Open risks', '')
    if (@($State.open_risks).Count) { $lines += @($State.open_risks | ForEach-Object { "- $_" }) } else { $lines += '- None.' }
    $lines += @('', '## Blockers', '')
    if (@($State.blockers).Count) { $lines += @($State.blockers | ForEach-Object { "- $_" }) } else { $lines += '- None.' }
    $lines += @('', '## Next action', '', [string]$State.next_action, '')
    return $lines -join "`n"
}

$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $RegenerateOnly) {
    if (-not $PatchJsonPath) { throw 'PatchJsonPath is required.' }
    $patch = Get-Content -LiteralPath (Resolve-Path -LiteralPath $PatchJsonPath) -Raw -Encoding UTF8 | ConvertFrom-Json
    $replace = @('version','authority_schema','status','current_phase','current_stage','goal','authoritative_artifacts','latest_correction','failed_routes','open_risks','blockers','next_action','verification')
    foreach ($property in $patch.PSObject.Properties) {
        switch ($property.Name) {
            'append_completed_receipts' { $state.completed_receipts = Unique-Append @($state.completed_receipts) @($property.Value) { param($x) [string]$x.id } }
            'update_completed_receipts' {
                foreach ($update in @($property.Value)) {
                    Assert-Receipt $update
                    $indices = @(for ($index = 0; $index -lt @($state.completed_receipts).Count; $index++) {
                        if ($state.completed_receipts[$index].id -eq $update.id) { $index }
                    })
                    if ($indices.Count -ne 1) { throw "Completed receipt id is not unique: $($update.id)" }
                    $state.completed_receipts[$indices[0]] = $update
                }
            }
            'append_authoritative_artifacts' { $state.authoritative_artifacts = Unique-Append @($state.authoritative_artifacts) @($property.Value) { param($x) "$($x.path)|$($x.sha256)|$($x.role)" } }
            'update_authoritative_artifact_hashes' {
                foreach ($update in @($property.Value)) {
                    if (-not [string]$update.path -or [string]$update.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
                        throw 'Authoritative artifact hash update is invalid.'
                    }
                    $matches = @($state.authoritative_artifacts | Where-Object { $_.path -eq $update.path })
                    if ($matches.Count -ne 1) { throw "Authoritative artifact path is not unique: $($update.path)" }
                    $matches[0].sha256 = [string]$update.sha256
                }
            }
            'append_decisions' { $state.decisions = Unique-Append @($state.decisions) @($property.Value) { param($x) [string]$x } }
            'replace_decisions' { $state.decisions = @($property.Value) }
            'append_do_not_repeat' { $state.do_not_repeat = Unique-Append @($state.do_not_repeat) @($property.Value) { param($x) [string]$x } }
            default { if ($replace -notcontains $property.Name) { throw "Unsupported state patch property: $($property.Name)" }; $state.($property.Name) = $property.Value }
        }
    }
    $state.state_generation = [int]$state.state_generation + 1
    $state.updated_at = [DateTimeOffset]::Now.ToString('o')
    Assert-State $state
    Write-Atomic $statePath ((($state | ConvertTo-Json -Depth 40) -replace "\r\n?", "`n") + "`n")
}
Assert-State $state
Write-Atomic $statusPath (Render-Status $state)
[pscustomobject]@{ status='PASS'; state_generation=$state.state_generation; state='manifests/PROJECT-STATE.json'; projection='PROJECT-STATUS.md' } | ConvertTo-Json
