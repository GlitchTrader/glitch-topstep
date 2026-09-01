# Append /health snapshots to a PRAC soak evidence directory (supervised sessions only).
param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDir,
    [string]$GatewayUrl = "http://127.0.0.1:8790",
    [string]$Token = $env:GLITCH_LOCAL_TOKEN,
    [int]$IntervalSeconds = 300,
    [int]$DurationHours = 72
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Token) {
    $envFile = Join-Path (Join-Path $PSScriptRoot "..") ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^GLITCH_LOCAL_TOKEN=(.+)$') { $Token = $Matches[1].Trim() }
        }
    }
}
if (-not $Token) { throw "Set GLITCH_LOCAL_TOKEN or configure .env" }

$root = Split-Path $PSScriptRoot -Parent
$out = if ([System.IO.Path]::IsPathRooted($EvidenceDir)) { $EvidenceDir } else { Join-Path $root $EvidenceDir }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$samplePath = Join-Path $out "health-samples.jsonl"
$headers = @{ Authorization = "Bearer $Token" }
$deadline = (Get-Date).AddHours($DurationHours)
$sampleIndex = 0

Write-Host "PRAC soak sampler -> $samplePath every ${IntervalSeconds}s for ${DurationHours}h" -ForegroundColor Cyan
Write-Host "Stop with Ctrl+C. Do not run unattended." -ForegroundColor Yellow

while ((Get-Date) -lt $deadline) {
    $started = Get-Date
    try {
        $health = Invoke-RestMethod -Uri "$GatewayUrl/health" -Headers $headers -TimeoutSec 30
        $row = [ordered]@{
            sample_index = $sampleIndex
            recorded_utc = (Get-Date).ToUniversalTime().ToString("o")
            health_build_ms = $health.health_build_ms
            status = $health.status
            trading_mode = $health.trading_mode
            gateway_mode = $health.gateway_mode
            state_complete = $health.data_quality.state_complete
            auth_degraded = $health.invariant_metrics.auth_degraded
            unprotected_open_quantity = $health.invariant_metrics.unprotected_open_quantity
            user_stream = $health.data_quality.operational.userStream.state
            market_stream = $health.data_quality.operational.marketStream.state
            reconciliation = $health.data_quality.operational.reconciliation.state
            recovery_active = $health.recovery.active
            recovery_generation = $health.recovery.generation
            task_scheduler = $health.task_scheduler
            evidence_queue_depth = $health.provider_evidence_queue.physical_depth
            ambiguous_mutations = $health.execution_recovery.ambiguousMutations
            blocking_new_exposure = $health.execution_recovery.blockingNewExposure
            alert_ids = @($health.health_alerts | ForEach-Object { $_.id })
        }
        ($row | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 $samplePath
        $sampleIndex++
    } catch {
        $err = [ordered]@{
            sample_index = $sampleIndex
            recorded_utc = (Get-Date).ToUniversalTime().ToString("o")
            error = $_.Exception.Message
        }
        ($err | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 $samplePath
        $sampleIndex++
    }
    $elapsed = ((Get-Date) - $started).TotalSeconds
    $sleep = [Math]::Max(1, $IntervalSeconds - [int]$elapsed)
    Start-Sleep -Seconds $sleep
}
