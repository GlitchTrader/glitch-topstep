# Ensure the glitch-topstep Hermes cron scheduler is running with a live gateway.pid.
# Without gateway.pid + gateway.lock, `hermes cron status` reports "Gateway is not running"
# even when cron launchers were started manually.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\ensure-hermes-gateway-scheduler.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\ensure-hermes-gateway-scheduler.ps1 -Profile glitch-topstep

#Requires -Version 5.1
param(
    [string]$Profile = 'glitch-topstep'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profileRoot = Join-Path (Join-Path $env:LOCALAPPDATA 'hermes\profiles') $Profile
if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    throw "Hermes profile not found: $profileRoot"
}

$hermes = Get-Command hermes -ErrorAction Stop
$previousHermesHome = $env:HERMES_HOME
$env:HERMES_HOME = $profileRoot

function Test-GatewayPidLive {
    param([string]$PidPath)
    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) {
        return $false
    }
    try {
        $record = Get-Content -LiteralPath $PidPath -Raw | ConvertFrom-Json
        $gatewayPid = [int]$record.pid
        if ($gatewayPid -le 0) { return $false }
        return $null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

try {
    Push-Location $profileRoot
    $pidPath = Join-Path $profileRoot 'gateway.pid'

    if (Test-GatewayPidLive -PidPath $pidPath) {
        $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
        Write-Host "Hermes gateway scheduler already running (PID $($record.pid))." -ForegroundColor Green
        return
    }

    Write-Host "Starting Hermes gateway scheduler for profile '$Profile'..." -ForegroundColor Cyan
    & $hermes.Source -p $Profile gateway start
    if ($LASTEXITCODE -ne 0) {
        throw "hermes gateway start failed with exit code $LASTEXITCODE"
    }

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (Test-GatewayPidLive -PidPath $pidPath) {
            $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
            Write-Host "Hermes gateway scheduler started (PID $($record.pid))." -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 750
    }

    $status = & $hermes.Source -p $Profile gateway status 2>&1 | Out-String
    if ($status -match 'Gateway process running') {
        Write-Host 'Hermes gateway scheduler is running (verified via hermes gateway status).' -ForegroundColor Green
        return
    }

    throw "gateway.pid was not created within 45s at $pidPath"
}
finally {
    Pop-Location
    $env:HERMES_HOME = $previousHermesHome
}
