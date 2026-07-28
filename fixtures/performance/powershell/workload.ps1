param([Parameter(Mandatory)][ValidateSet('BASELINE', 'CANDIDATE')][string]$Arm)

$value = if ($Arm -eq 'BASELINE') { 100 } else { 90 }
[ordered]@{ value = $value; unit = 'ms'; quality = 'PASS' } | ConvertTo-Json -Compress
