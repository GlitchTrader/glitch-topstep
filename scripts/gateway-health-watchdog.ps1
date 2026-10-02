# Poll /health and restart the gateway process when ProjectX streams stay dead.
# Intended as a process-level fallback when in-process hub restart cannot recover.
# Launch via install-gateway-watchdog.ps1 (VBS wrapper keeps the console fully hidden).
[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$HealthUrl = "http://127.0.0.1:8790/health",
    [int]$Port = 8790,
    [int]$DegradedGraceMinutes = 3,
    [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"
# param defaults evaluate before $PSScriptRoot is bound; resolve paths in-body.
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
Set-Location $RepoRoot

function Write-WatchdogLog {
    param([string]$Message)
    $logDir = Join-Path $RepoRoot "data"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $line = "{0:o} {1}" -f [DateTimeOffset]::UtcNow, $Message
    Add-Content -Path (Join-Path $logDir "gateway-watchdog.log") -Value $line -Encoding utf8
}

function Read-LocalToken {
    $envPath = Join-Path $RepoRoot ".env"
    if (-not (Test-Path $envPath)) { throw "Missing .env at $envPath" }
    foreach ($line in Get-Content $envPath) {
        $trim = $line.Trim()
        if (-not $trim -or $trim.StartsWith("#") -or -not $trim.Contains("=")) { continue }
        $eq = $trim.IndexOf("=")
        $name = $trim.Substring(0, $eq).Trim()
        if ($name -eq "GLITCH_LOCAL_TOKEN") {
            return $trim.Substring($eq + 1).Trim()
        }
    }
    throw "GLITCH_LOCAL_TOKEN missing from .env"
}

function Get-Health {
    param([string]$Token)
    try {
        return Invoke-RestMethod -Uri $HealthUrl -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 12
    } catch {
        return $null
    }
}

# Unauthenticated /health is liveness-only (no SQLite stores). Distinguishes wedged handler from dead process.
function Get-Liveness {
    try {
        return Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    } catch {
        return $null
    }
}

function Format-EventLoopDelay {
    param($Health)
    if ($null -eq $Health -or $null -eq $Health.event_loop_delay) {
        return "event_loop_delay=unavailable"
    }
    $eld = $Health.event_loop_delay
    return "event_loop_delay_max_ms=$($eld.max_ms) event_loop_delay_p99_ms=$($eld.p99_ms) event_loop_delay_mean_ms=$($eld.mean_ms)"
}

function Format-SqliteWriteLatency {
    param($Health)
    if ($null -eq $Health -or $null -eq $Health.sqlite_write_latency) {
        return "sqlite_write_latency=unavailable"
    }
    $sw = $Health.sqlite_write_latency
    $execMax = $sw.execution.max_write_latency_ms
    $ctrlMax = $sw.control.max_write_latency_ms
    $outMax = $sw.outcome_feed.max_write_latency_ms
    $evidMax = $sw.evidence_queue.max_write_latency_ms
    $build = $Health.health_build_ms
    $eld = Format-EventLoopDelay $Health
    $apply = Format-ApplyLag $Health
    return "health_build_ms=$build $eld exec_write_max_ms=$execMax control_write_max_ms=$ctrlMax outcome_write_max_ms=$outMax evid_write_max_ms=$evidMax $apply"
}

function Format-ApplyLag {
    param($Health)
    if ($null -eq $Health -or $null -eq $Health.apply_lag) {
        return "apply_lag=unavailable"
    }
    $quote = $Health.apply_lag.quote
    $identity = $Health.apply_lag.identity
    $quoteAge = "na"
    $stateAge = "na"
    if ($null -ne $Health.data_quality) {
        $quoteAge = $Health.data_quality.quote_age_ms
        $stateAge = $Health.data_quality.state_age_ms
    }
    return "quote_age_ms=$quoteAge state_age_ms=$stateAge apply_lag_quote_max_ms=$($quote.max_ms) apply_lag_quote_p99_ms=$($quote.p99_ms) apply_lag_quote_count=$($quote.count) apply_lag_identity_max_ms=$($identity.max_ms) apply_lag_identity_p99_ms=$($identity.p99_ms) apply_lag_identity_count=$($identity.count)"
}

function Write-HealthUnreachableProbe {
    param([string]$Token)
    $liveness = Get-Liveness
    $livenessPart = if ($null -eq $liveness) {
        "liveness=unreachable"
    } else {
        "liveness=ok status=$([string]$liveness.status)"
    }
    # Auth /health already failed; liveness may still carry event_loop_delay (no reset) for Passo 1.
    $eld = Format-EventLoopDelay $liveness
    $apply = Format-ApplyLag $liveness
    Write-WatchdogLog "health_unreachable auth_health=timeout $livenessPart $eld sqlite_write_latency=unavailable $apply note=telemetry_blocked_by_health_stall"
}

# Keep in sync with src/observability/gateway-watchdog-policy.ts (tests/gateway-watchdog-policy.test.ts).
function Test-RecoveryProgressFresh {
    param($Recovery, $Now)
    if ($null -eq $Recovery -or -not $Recovery.active) { return $false }
    $progressAt = [string]$Recovery.last_progress_at
    if (-not $progressAt) { return $false }
    $progress = [DateTimeOffset]::Parse($progressAt)
    $ageMs = ($Now - $progress).TotalMilliseconds
    return ($ageMs -ge 0) -and ($ageMs -lt 300000)
}

function Test-BaseWatchdogRecoveryNeeded {
    param($Health)
    if ([string]$Health.status -ne "degraded") { return $false }
    $issues = @($Health.data_quality.issues)
    $streamStuck = ($issues -contains "market_stream_disconnected") `
        -or ($issues -contains "user_stream_disconnected") `
        -or ($issues -contains "market_stream_connecting") `
        -or ($issues -contains "user_stream_connecting") `
        -or ($issues -contains "market_stream_reconnecting") `
        -or ($issues -contains "user_stream_reconnecting")
    $quoteStale = $issues -contains "quote_stale"
    $reconciliationStale = $issues -contains "reconciliation_not_current"
    return $quoteStale -and ($streamStuck -or $reconciliationStale)
}

function Get-WatchdogRestartCause {
    param($Health)
    if ($null -eq $Health) { return "health_unreachable" }
    if (-not (Test-BaseWatchdogRecoveryNeeded -Health $Health)) { return "not_needed" }
    $recovery = $Health.recovery
    if ($null -ne $recovery -and $recovery.active) {
        if (Test-RecoveryProgressFresh -Recovery $recovery -Now $now) {
            return "recovery_progress_fresh"
        }
        $deadlineAt = [string]$recovery.deadline_at
        if ($deadlineAt -and $now -lt [DateTimeOffset]::Parse($deadlineAt)) {
            return "recovery_within_deadline"
        }
        return "recovery_stalled_past_deadline"
    }
    $issues = @($Health.data_quality.issues)
    if (($issues -contains "quote_stale") -and (
        ($issues -contains "market_stream_reconnecting") -or
        ($issues -contains "user_stream_reconnecting") -or
        ($issues -contains "market_stream_disconnected") -or
        ($issues -contains "user_stream_disconnected") -or
        ($issues -contains "market_stream_connecting") -or
        ($issues -contains "user_stream_connecting"))) {
        return "quote_stale_with_stream_stuck"
    }
    if (($issues -contains "quote_stale") -and ($issues -contains "reconciliation_not_current")) {
        return "quote_stale_with_reconciliation_lag"
    }
    return "degraded_recovery_needed"
}

function Test-WatchdogRecoveryNeeded {
    param($Health)
    if ($null -eq $Health) { return $true }
    if (-not (Test-BaseWatchdogRecoveryNeeded -Health $Health)) { return $false }
    $recovery = $Health.recovery
    if ($null -eq $recovery -or -not $recovery.active) { return $true }
    if (Test-RecoveryProgressFresh -Recovery $recovery -Now ([DateTimeOffset]::UtcNow)) { return $false }
    $deadlineAt = [string]$recovery.deadline_at
    if ($deadlineAt -and ([DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($deadlineAt))) {
        return $false
    }
    return $true
}

function Get-LatestStartupOutboxDrain {
    $logPath = Join-Path $RepoRoot "data\gateway.stdout.log"
    if (-not (Test-Path $logPath)) { return $null }
    $lines = @(Get-Content $logPath -Tail 400 -ErrorAction SilentlyContinue)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -match 'startup_outbox_drain\s+(\{.*\})') {
            try {
                $parsed = $Matches[1] | ConvertFrom-Json
                $pidValue = 0
                if ($null -ne $parsed.pid) { $pidValue = [int]$parsed.pid }
                # A line from a dead PID is the previous boot. Treating it as current
                # would stall-kill the successor before it logs its own drain.
                if ($pidValue -gt 0 -and -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
                    return $null
                }
                return @{
                    pending = [int]$parsed.pending
                    drained_so_far = [int]$parsed.drained_so_far
                    pid = $pidValue
                }
            } catch { return $null }
        }
    }
    return $null
}

# Keep in sync with startupOutboxDrainDecision in gateway-watchdog-policy.ts.
function Get-StartupOutboxDrainDecision {
    param($Previous, $Current)
    if ($null -eq $Current -or $Current.pending -le 0) { return "absent" }
    if ($null -eq $Previous) { return "hold" }
    if ($Current.pid -gt 0 -and $Previous.pid -gt 0 -and $Current.pid -ne $Previous.pid) { return "hold" }
    if ($Current.pending -lt $Previous.pending -or $Current.drained_so_far -gt $Previous.drained_so_far) {
        return "hold"
    }
    return "stalled"
}

function Assert-WatchdogDistIsMain {
    $expected = (& git -C $RepoRoot rev-parse origin/main 2>$null).Trim()
    $head = (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
    $stampPath = Join-Path $RepoRoot "dist\BUILD_COMMIT"
    $built = ""
    if (Test-Path $stampPath) {
        $built = (Get-Content -Path $stampPath -Raw).Trim()
    }
    if (-not $expected -or $built -ne $expected -or $head -ne $expected) {
        $failPath = Join-Path $RepoRoot "data\gateway-startup-failure.txt"
        New-Item -ItemType Directory -Force -Path (Split-Path $failPath) | Out-Null
        Set-Content -Path $failPath -Value "dist_commit_mismatch" -Encoding ascii
        throw "gateway_startup_failed:dist_commit_mismatch built=$built HEAD=$head expected=$expected"
    }
}

function Restart-GatewayProcess {
    # Refuse before stopping the current process. A mismatched dist must not replace a live gateway.
    Assert-WatchdogDistIsMain
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $procId = [int]$listener.OwningProcess
        if ($procId -gt 0) {
            Write-WatchdogLog "stopping PID $procId on :$Port"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    # Startup drain has not opened the port yet. A listener-only stop would leave the
    # stuck node holding the runtime lock and the next start would fail closed.
    $gatewayNodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dist[/\\]src[/\\]index\.js' })
    foreach ($node in $gatewayNodes) {
        Write-WatchdogLog "stopping gateway PID $($node.ProcessId)"
        Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $startScript = Join-Path $RepoRoot "start.ps1"
    # Hidden child — never pipe to Out-Host (that forces a console).
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $startScript, "-SkipBuild") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -Wait
    Write-WatchdogLog "start.ps1 exit=$($proc.ExitCode)"
    if ($proc.ExitCode -ne 0) {
        $causePath = Join-Path $RepoRoot "data\gateway-startup-failure.txt"
        $cause = "start_ps1_exit_$($proc.ExitCode)"
        if (Test-Path $causePath) {
            $cause = (Get-Content -Path $causePath -Raw).Trim()
        }
        throw "gateway_startup_failed:$cause"
    }
}

# Same rule as recordStartupFailure / startupFailureBlocksRestart in gateway-watchdog-policy.ts.
function Invoke-GuardedGatewayRestart {
    param($State)
    if ([int]$State.startup_failure_count -ge 3 -and $State.startup_failure_cause) {
        Write-WatchdogLog "startup_failure_repeated cause=$($State.startup_failure_cause) count=$($State.startup_failure_count)"
        return "repeated"
    }
    try {
        Restart-GatewayProcess
        $State.startup_failure_cause = $null
        $State.startup_failure_count = 0
        return "ok"
    } catch {
        $message = [string]$_.Exception.Message
        $cause = if ($message -match "gateway_startup_failed:\s*(\S+)") { $Matches[1] } else { ($message -replace "\s+", "_") }
        if ([string]$State.startup_failure_cause -eq $cause) {
            $State.startup_failure_count = [int]$State.startup_failure_count + 1
        } else {
            $State.startup_failure_cause = $cause
            $State.startup_failure_count = 1
        }
        if ([int]$State.startup_failure_count -ge 3) {
            Write-WatchdogLog "startup_failure_repeated cause=$($State.startup_failure_cause) count=$($State.startup_failure_count)"
            return "repeated"
        }
        Write-WatchdogLog "error: $message"
        return "error"
    }
}

try {
    if (-not $StatePath) {
        $dataDir = Join-Path $RepoRoot "data"
        New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
        $StatePath = Join-Path $dataDir "gateway-watchdog-state.json"
    }

    $token = Read-LocalToken
    $health = Get-Health -Token $token
    $now = [DateTimeOffset]::UtcNow
    if ($null -eq $health) {
        Write-HealthUnreachableProbe -Token $token
    }

    $state = @{
        schema_version = "glitch.topstep.gateway_watchdog.v1"
        first_dead_utc = $null
        last_check_utc = $now.ToString("o")
        last_restart_utc = $null
        startup_drain_pending = $null
        startup_drain_drained_so_far = $null
        startup_drain_pid = $null
        startup_failure_cause = $null
        startup_failure_count = 0
    }
    if (Test-Path $StatePath) {
        try {
            $loaded = Get-Content $StatePath -Raw | ConvertFrom-Json
            if ($loaded.first_dead_utc) { $state.first_dead_utc = [string]$loaded.first_dead_utc }
            if ($loaded.last_restart_utc) { $state.last_restart_utc = [string]$loaded.last_restart_utc }
            if ($loaded.startup_failure_cause) { $state.startup_failure_cause = [string]$loaded.startup_failure_cause }
            if ($null -ne $loaded.startup_failure_count) { $state.startup_failure_count = [int]$loaded.startup_failure_count }
            if ($null -ne $loaded.startup_drain_pending -and $null -ne $loaded.startup_drain_drained_so_far) {
                $state.startup_drain_pending = [int]$loaded.startup_drain_pending
                $state.startup_drain_drained_so_far = [int]$loaded.startup_drain_drained_so_far
                if ($null -ne $loaded.startup_drain_pid) { $state.startup_drain_pid = [int]$loaded.startup_drain_pid }
            }
        } catch { }
    }

    $currentDrain = Get-LatestStartupOutboxDrain
    $previousDrain = $null
    if ($null -ne $state.startup_drain_pending) {
        $previousDrain = @{
            pending = [int]$state.startup_drain_pending
            drained_so_far = [int]$state.startup_drain_drained_so_far
            pid = [int]$state.startup_drain_pid
        }
    }
    $drainDecision = Get-StartupOutboxDrainDecision -Previous $previousDrain -Current $currentDrain
    if ($null -ne $health -or $drainDecision -eq "absent") {
        $state.startup_drain_pending = $null
        $state.startup_drain_drained_so_far = $null
        $state.startup_drain_pid = $null
        $drainDecision = "absent"
    } elseif ($drainDecision -eq "hold" -and $null -ne $currentDrain) {
        $state.startup_drain_pending = $currentDrain.pending
        $state.startup_drain_drained_so_far = $currentDrain.drained_so_far
        $state.startup_drain_pid = [int]$currentDrain.pid
    }

    $cause = Get-WatchdogRestartCause -Health $health
    $dead = Test-WatchdogRecoveryNeeded -Health $health
    if ($null -eq $health -and $drainDecision -eq "hold") {
        $dead = $false
        $cause = "startup_outbox_drain_progressing"
    } elseif ($null -eq $health -and $drainDecision -eq "stalled") {
        $dead = $true
        $cause = "startup_outbox_drain_stalled"
    }

    if (-not $dead) {
        $state.first_dead_utc = $null
        $state.startup_failure_cause = $null
        $state.startup_failure_count = 0
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        $status = if ($null -eq $health) { "unreachable" } else { [string]$health.status }
        $latency = Format-SqliteWriteLatency -Health $health
        $drainNote = ""
        if ($cause -eq "startup_outbox_drain_progressing") {
            $drainNote = " pending=$($currentDrain.pending) drained_so_far=$($currentDrain.drained_so_far)"
        }
        Write-WatchdogLog "ok status=$status cause=$cause $latency$drainNote"
        exit 0
    }

    if ($cause -eq "startup_outbox_drain_stalled") {
        Write-WatchdogLog "restarting startup outbox drain stalled pending=$($currentDrain.pending) drained_so_far=$($currentDrain.drained_so_far)"
        $restartResult = Invoke-GuardedGatewayRestart -State $state
        if ($restartResult -eq "ok") {
            $state.first_dead_utc = $null
            $state.startup_drain_pending = $null
            $state.startup_drain_drained_so_far = $null
            $state.startup_drain_pid = $null
            $state.last_restart_utc = [DateTimeOffset]::UtcNow.ToString("o")
        }
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        if ($restartResult -eq "ok") {
            Write-WatchdogLog "restart complete"
        }
        if ($restartResult -eq "error") { exit 1 }
        exit 0
    }

    if (-not $state.first_dead_utc) {
        $state.first_dead_utc = $now.ToString("o")
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        Write-WatchdogLog "degraded grace started at $($state.first_dead_utc) cause=$cause"
        exit 0
    }

    $firstDead = [DateTimeOffset]::Parse([string]$state.first_dead_utc)
    $ageMinutes = ($now - $firstDead).TotalMinutes
    if ($ageMinutes -lt $DegradedGraceMinutes) {
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        Write-WatchdogLog ("degraded {0:N1}m < grace {1}m cause={2}" -f $ageMinutes, $DegradedGraceMinutes, $cause)
        exit 0
    }

    Write-WatchdogLog ("restarting after {0:N1}m degraded cause={1}" -f $ageMinutes, $cause)
    $restartResult = Invoke-GuardedGatewayRestart -State $state
    if ($restartResult -eq "ok") {
        $state.first_dead_utc = $null
        $state.last_restart_utc = [DateTimeOffset]::UtcNow.ToString("o")
    }
    ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
    if ($restartResult -eq "ok") {
        Write-WatchdogLog "restart complete"
    }
    if ($restartResult -eq "error") { exit 1 }
    exit 0
} catch {
    Write-WatchdogLog "error: $($_.Exception.Message)"
    exit 1
}
