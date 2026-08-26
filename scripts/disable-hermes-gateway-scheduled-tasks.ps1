# Disable Hermes "gateway run" scheduled tasks (cron scheduler autostart via Task Scheduler).
# Keeps GlitchTopstep_Gateway (node start.ps1) as the sole HTTP/trading gateway on :8790.
# Hermes cron for glitch-topstep should autostart via Startup\Hermes_Gateway_glitch-topstep.vbs only.
# Run once elevated: powershell -ExecutionPolicy Bypass -File scripts\disable-hermes-gateway-scheduled-tasks.ps1

#Requires -Version 5.1
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toDisable = @(
    'Hermes_Gateway',
    'Hermes_Gateway_glitch',
    'Hermes_Gateway_glitch-topstep'
)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    if (-not $Force) {
        Write-Host 'Re-launching elevated (UAC)...' -ForegroundColor Yellow
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', $PSCommandPath,
            '-Force'
        ) | Out-Null
        exit 0
    }
    throw 'Administrator approval required to disable scheduled tasks.'
}

foreach ($name in $toDisable) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "Skip (missing): $name"
        continue
    }
    Disable-ScheduledTask -TaskName $name | Out-Null
    Write-Host "Disabled: $name" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Kept enabled (do not disable):' -ForegroundColor Cyan
Get-ScheduledTask -TaskName 'GlitchTopstep_Gateway', 'GlitchTopstep_GatewayWatchdog' -ErrorAction SilentlyContinue |
    ForEach-Object {
        $enabled = $_.Settings.Enabled
        Write-Host "  $($_.TaskName): State=$($_.State) Enabled=$enabled"
    }
