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

# Keep in sync with src/observability/gateway-watchdog-policy.ts (tests/gateway-watchdog-policy.test.ts).
function Test-WatchdogRecoveryNeeded {
    param($Health)
    if ($null -eq $Health) { return $true }
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

function Restart-GatewayProcess {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $procId = [int]$listener.OwningProcess
        if ($procId -gt 0) {
            Write-WatchdogLog "stopping PID $procId on :$Port"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
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
        throw "start.ps1 failed with exit $($proc.ExitCode)"
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
    $dead = Test-WatchdogRecoveryNeeded -Health $health

    $state = @{
        schema_version = "glitch.topstep.gateway_watchdog.v1"
        first_dead_utc = $null
        last_check_utc = $now.ToString("o")
        last_restart_utc = $null
    }
    if (Test-Path $StatePath) {
        try {
            $loaded = Get-Content $StatePath -Raw | ConvertFrom-Json
            if ($loaded.first_dead_utc) { $state.first_dead_utc = [string]$loaded.first_dead_utc }
            if ($loaded.last_restart_utc) { $state.last_restart_utc = [string]$loaded.last_restart_utc }
        } catch { }
    }

    if (-not $dead) {
        $state.first_dead_utc = $null
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        $status = if ($null -eq $health) { "unreachable" } else { [string]$health.status }
        Write-WatchdogLog "ok status=$status"
        exit 0
    }

    if (-not $state.first_dead_utc) {
        $state.first_dead_utc = $now.ToString("o")
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        Write-WatchdogLog "degraded grace started at $($state.first_dead_utc)"
        exit 0
    }

    $firstDead = [DateTimeOffset]::Parse([string]$state.first_dead_utc)
    $ageMinutes = ($now - $firstDead).TotalMinutes
    if ($ageMinutes -lt $DegradedGraceMinutes) {
        ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
        Write-WatchdogLog ("degraded {0:N1}m < grace {1}m" -f $ageMinutes, $DegradedGraceMinutes)
        exit 0
    }

    Write-WatchdogLog ("restarting after {0:N1}m degraded" -f $ageMinutes)
    Restart-GatewayProcess
    $state.first_dead_utc = $null
    $state.last_restart_utc = [DateTimeOffset]::UtcNow.ToString("o")
    ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8
    Write-WatchdogLog "restart complete"
    exit 0
} catch {
    Write-WatchdogLog "error: $($_.Exception.Message)"
    exit 1
}
