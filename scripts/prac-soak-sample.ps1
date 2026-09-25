# Append /health snapshots to a PRAC soak evidence directory (supervised sessions only).
param(
    [string]$EvidenceDir,
    [string]$GatewayUrl = "http://127.0.0.1:8790",
    [string]$Token = $env:GLITCH_LOCAL_TOKEN,
    [int]$IntervalSeconds = 300,
    [int]$DurationHours = 72,
    [switch]$SelfCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# /health v3 renamed health_alerts[].id -> alert_id (2026-08-31). StrictMode throws on missing .id.
function Get-NoteProperty($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    $prop = $obj.PSObject.Properties[$name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-HealthAlertIds($health) {
    $alerts = Get-NoteProperty $health "health_alerts"
    if ($null -eq $alerts) { return @() }
    return @(
        @($alerts) | ForEach-Object {
            $id = Get-NoteProperty $_ "alert_id"
            if ($null -eq $id) { $id = Get-NoteProperty $_ "id" }
            $id
        } | Where-Object { $_ }
    )
}

if ($SelfCheck) {
    $fake = [pscustomobject]@{
        health_alerts = @(
            [pscustomobject]@{ alert_id = "quote_stale" }
            [pscustomobject]@{ id = "legacy" }
        )
        rest_concurrency = [pscustomobject]@{ in_flight = 2; waiting = 1 }
        user_recovery = [pscustomobject]@{ generation = 4 }
        heap_used_bytes = 123456
        data_quality = [pscustomobject]@{ issues = @("quote_stale", "reconciliation_not_current") }
    }
    $ids = @(Get-HealthAlertIds $fake)
    if ($ids -notcontains "quote_stale" -or $ids -notcontains "legacy") {
        throw "self-check: expected alert_id and legacy id, got $($ids -join ',')"
    }
    if ((Get-NoteProperty (Get-NoteProperty $fake "rest_concurrency") "in_flight") -ne 2) {
        throw "self-check: rest_in_flight"
    }
    if ((Get-NoteProperty (Get-NoteProperty $fake "user_recovery") "generation") -ne 4) {
        throw "self-check: user_recovery_generation"
    }
    if ((Get-NoteProperty $fake "heap_used_bytes") -ne 123456) {
        throw "self-check: heap_used_bytes"
    }
    $issues = @(Get-NoteProperty (Get-NoteProperty $fake "data_quality") "issues")
    if ($issues -notcontains "quote_stale" -or $issues.Count -ne 2) {
        throw "self-check: data_quality.issues"
    }
    if (@(Get-HealthAlertIds ([pscustomobject]@{})).Count -ne 0) {
        throw "self-check: missing health_alerts must be empty"
    }
    Write-Host "prac-soak-sample self-check ok"
    exit 0
}

if (-not $EvidenceDir) { throw "EvidenceDir is required unless -SelfCheck" }

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
$t0Path = Join-Path $out "t0.json"
if (Test-Path $t0Path) {
    $t0 = Get-Content $t0Path -Raw | ConvertFrom-Json
    $planned = Get-NoteProperty $t0 "planned_end_utc"
    if ($planned) {
        $deadline = [datetimeoffset]::Parse([string]$planned).LocalDateTime
    }
}
$sampleIndex = 0
if (Test-Path $samplePath) {
    $sampleIndex = @(Get-Content $samplePath).Count
}

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
            alert_ids = @(Get-HealthAlertIds $health)
            rest_in_flight = Get-NoteProperty (Get-NoteProperty $health "rest_concurrency") "in_flight"
            rest_waiting = Get-NoteProperty (Get-NoteProperty $health "rest_concurrency") "waiting"
            user_recovery_generation = Get-NoteProperty (Get-NoteProperty $health "user_recovery") "generation"
            heap_used_bytes = Get-NoteProperty $health "heap_used_bytes"
            data_quality_issues = @(Get-NoteProperty (Get-NoteProperty $health "data_quality") "issues")
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
