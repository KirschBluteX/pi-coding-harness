[CmdletBinding()]
param(
    [string]$Provider,
    [string]$Api = 'openai-completions',
    [ValidateRange(1, 10000)][int]$Window = 200,
    [ValidateRange(1, 10000)][int]$MinimumSamples = 30,
    [string]$AgentDir = (Join-Path $HOME '.pi\agent'),
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)

function Get-Sha256Text([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) }
    finally { $algorithm.Dispose() }
    return ($digest | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-NonnegativeInteger($Value) {
    if ($null -eq $Value) { return $null }
    [long]$number = 0
    if (-not [long]::TryParse([string]$Value, [ref]$number) -or $number -lt 0) { return $null }
    return $number
}

function Get-TimestampMs($Primary, $Secondary, [IO.FileInfo]$File) {
    foreach ($candidate in @($Primary, $Secondary)) {
        $number = Get-NonnegativeInteger $candidate
        if ($null -ne $number) { return $number }
        if ($candidate) {
            [DateTimeOffset]$parsed = [DateTimeOffset]::MinValue
            if ([DateTimeOffset]::TryParse([string]$candidate, [ref]$parsed)) { return $parsed.ToUnixTimeMilliseconds() }
        }
    }
    return ([DateTimeOffset]$File.LastWriteTimeUtc).ToUnixTimeMilliseconds()
}

$settingsPath = Join-Path $AgentDir 'settings.json'
$modelsPath = Join-Path $AgentDir 'models.json'
$sessionsPath = Join-Path $AgentDir 'sessions'
if (-not (Test-Path -LiteralPath $settingsPath) -or -not (Test-Path -LiteralPath $modelsPath) -or -not (Test-Path -LiteralPath $sessionsPath)) {
    throw 'Pi settings, models, or sessions are unavailable.'
}
$settings = Get-Content -Raw -LiteralPath $settingsPath -Encoding UTF8 | ConvertFrom-Json
if (-not $Provider) { $Provider = [string]$settings.defaultProvider }
if (-not $Provider) { throw 'Provider is required.' }
if ($Provider -ne 'geekspace' -or $Api -ne 'openai-completions') {
    throw 'This evidence generator implements only the geekspace/openai-completions provider contract.'
}
$models = Get-Content -Raw -LiteralPath $modelsPath -Encoding UTF8 | ConvertFrom-Json
$providerProperty = $models.providers.PSObject.Properties | Where-Object Name -eq $Provider | Select-Object -First 1
if (-not $providerProperty) { throw "Provider is absent from Pi models.json: $Provider" }
$providerConfig = $providerProperty.Value
if ([string]$providerConfig.api -ne $Api) { throw "Provider API mismatch: expected $Api, observed $($providerConfig.api)" }
$baseUrl = [string]$providerConfig.baseUrl
if (-not $baseUrl) { throw 'Provider base URL is unavailable.' }
if ($baseUrl.TrimEnd('/') -ne 'https://geekspace.cloud/v1') { throw 'Provider base URL does not match the verified contract.' }

$observations = [Collections.Generic.List[object]]::new()
foreach ($file in Get-ChildItem -LiteralPath $sessionsPath -Recurse -File -Filter '*.jsonl') {
    $sessionSha = Get-Sha256Text $file.Name
    $ordinal = 0
    foreach ($line in [IO.File]::ReadLines($file.FullName)) {
        $ordinal++
        try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $message = if ($entry.PSObject.Properties.Name -contains 'message') { $entry.message } else { $entry }
        if ($message.role -ne 'assistant' -or $message.provider -ne $Provider -or -not $message.usage) { continue }
        $inputTokens = Get-NonnegativeInteger $message.usage.input
        $cacheReadTokens = Get-NonnegativeInteger $message.usage.cacheRead
        $cacheWriteTokens = Get-NonnegativeInteger $message.usage.cacheWrite
        $outputTokens = Get-NonnegativeInteger $message.usage.output
        if ($null -in @($inputTokens, $cacheReadTokens, $cacheWriteTokens, $outputTokens)) { continue }
        $observations.Add([pscustomobject][ordered]@{
            timestamp_ms = Get-TimestampMs $message.timestamp $entry.timestamp $file
            session_sha256 = $sessionSha
            ordinal = $ordinal
            model = [string]$message.model
            input = $inputTokens
            cache_read = $cacheReadTokens
            cache_write = $cacheWriteTokens
            output = $outputTokens
        })
    }
}

$selected = @($observations | Sort-Object -Property @{Expression='timestamp_ms';Descending=$true}, @{Expression='session_sha256';Descending=$false}, @{Expression='ordinal';Descending=$false} | Select-Object -First $Window)
if ($selected.Count -eq 0) { throw "No normalized usage samples were found for $Provider." }
$orderedMembership = @($selected | Sort-Object timestamp_ms, session_sha256, ordinal | ForEach-Object {
    [ordered]@{ timestamp_ms=$_.timestamp_ms; session_sha256=$_.session_sha256; ordinal=$_.ordinal; model=$_.model; input=$_.input; cache_read=$_.cache_read; cache_write=$_.cache_write; output=$_.output } | ConvertTo-Json -Compress
})
$membershipSha256 = Get-Sha256Text ($orderedMembership -join "`n")
$inputSum = [long](($selected | Measure-Object input -Sum).Sum)
$cacheReadSum = [long](($selected | Measure-Object cache_read -Sum).Sum)
$cacheWriteSum = [long](($selected | Measure-Object cache_write -Sum).Sum)
$effectiveInput = $inputSum + $cacheReadSum + $cacheWriteSum
$positive = @($selected | Where-Object cache_read -gt 0).Count
$canActivate = $selected.Count -ge $MinimumSamples -and $positive -gt 0
$piCommand = Get-Command pi -ErrorAction Stop
$piBinRoot = Split-Path -Parent $piCommand.Source
$piPackagePath = @(
    (Join-Path $piBinRoot 'node_modules\@earendil-works\pi-coding-agent\package.json'),
    (Join-Path $piBinRoot 'node_modules\@mariozechner\pi-coding-agent\package.json')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $piPackagePath) { throw 'Installed Pi package metadata is unavailable.' }
$piVersion = [string]((Get-Content -Raw -LiteralPath $piPackagePath -Encoding UTF8 | ConvertFrom-Json).version)
$firstMs = [long](($selected | Measure-Object timestamp_ms -Minimum).Minimum)
$lastMs = [long](($selected | Measure-Object timestamp_ms -Maximum).Maximum)

$document = [ordered]@{
    '$schema' = '../schemas/cache-provider-evidence.schema.json'
    schema_version = 1
    evidence_id = 'PCH-CACHE-EVIDENCE-' + $Provider.ToUpperInvariant().Replace('_','-') + '-001'
    generated_at = [DateTimeOffset]::Now.ToString('o')
    source = [ordered]@{
        kind = 'PREEXISTING_PI_SESSION_NORMALIZED_USAGE'
        pi_version = $piVersion
        provider = $Provider
        api = $Api
        base_url = $baseUrl
        content_retained = $false
        credentials_accessed = $false
    }
    window = [ordered]@{
        policy = 'LATEST_PREEXISTING_PROVIDER_USAGE'
        requested_samples = $Window
        selected_samples = $selected.Count
        session_count = @($selected.session_sha256 | Sort-Object -Unique).Count
        first_at = [DateTimeOffset]::FromUnixTimeMilliseconds($firstMs).ToString('o')
        last_at = [DateTimeOffset]::FromUnixTimeMilliseconds($lastMs).ToString('o')
        membership_sha256 = $membershipSha256
        fixed_before_activation = $true
    }
    usage = [ordered]@{
        positive_cache_read_samples = $positive
        zero_cache_read_samples = @($selected | Where-Object cache_read -eq 0).Count
        uncached_input_tokens = $inputSum
        cache_read_tokens = $cacheReadSum
        cache_write_tokens = $cacheWriteSum
        effective_input_tokens = $effectiveInput
        positive_provider_report_share = [double]($positive / $selected.Count)
        token_read_share = [double]$(if ($effectiveInput -gt 0) { $cacheReadSum / $effectiveInput } else { 0 })
    }
    models_observed = @($selected | Group-Object model | Sort-Object Name | ForEach-Object {
        [ordered]@{ model = $_.Name; samples = $_.Count }
    })
    semantics = [ordered]@{
        positive_cache_read = 'PROVIDER_REPORTED_HIT'
        zero_cache_read = 'UNOBSERVABLE'
        pi_normalization = 'MISSING_CACHED_TOKENS_DEFAULTS_TO_ZERO'
        request_hit_rate_claim = 'PROHIBITED'
    }
    decision = [ordered]@{
        result = $(if ($canActivate) { 'ACTIVATE' } else { 'EXTERNAL_LIMIT' })
        arm = $(if ($canActivate) { 'C1_PREFIX' } else { 'C0' })
        provider_integration = $(if ($canActivate) { 'geekspace-openai-completions-positive-usage-v1' } else { $null })
        allow_payload_mutation = $false
        allow_live_canary = $false
        fallback = 'C0'
        reason = $(if ($canActivate) {
            "The frozen pre-activation window contains $($selected.Count) valid samples and $positive positive provider-reported Cache reads."
        } else {
            "The frozen pre-activation window does not meet the $MinimumSamples-sample positive-usage evidence floor."
        })
    }
    limitations = @(
        'Pi 0.82.1 maps an absent cached_tokens field to zero, so zero cannot prove a Cache miss.',
        'This evidence authorizes non-mutating C1 observation only; it does not authorize provider payload fields or headers.',
        'Positive provider-report share and token-read share are descriptive diagnostics, not a guaranteed future hit rate.'
    )
}

if ($OutputPath) {
    $absoluteOutput = if ([IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path (Get-Location) $OutputPath }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $absoluteOutput)) | Out-Null
    $temporary = $absoluteOutput + '.tmp.' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, (($document | ConvertTo-Json -Depth 20) + "`n"), $utf8)
    if (Test-Path -LiteralPath $absoluteOutput) {
        $backup = $temporary + '.bak'
        try { [IO.File]::Replace($temporary, $absoluteOutput, $backup, $true) }
        finally { if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) } }
    } else { [IO.File]::Move($temporary, $absoluteOutput) }
}

[pscustomobject]@{
    status = $(if ($canActivate) { 'PASS' } else { 'EXTERNAL_LIMIT' })
    provider = $Provider
    selected_samples = $selected.Count
    positive_cache_read_samples = $positive
    membership_sha256 = $membershipSha256
    output = $(if ($OutputPath) { $OutputPath } else { $null })
} | ConvertTo-Json
