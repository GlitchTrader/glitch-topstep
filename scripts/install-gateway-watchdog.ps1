# Registers a per-user scheduled task that runs gateway-health-watchdog.ps1 every 2 minutes.
param(
    [string]$TaskName = "GlitchTopstep_GatewayWatchdog",
    [int]$IntervalMinutes = 2
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $PSScriptRoot "gateway-health-watchdog.ps1"
if (-not (Test-Path $watchdog)) {
    throw "Missing $watchdog"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Restart Glitch Topstep gateway if ProjectX streams stay degraded." |
    Out-Null

Write-Host "Registered scheduled task '$TaskName' (every ${IntervalMinutes}m)." -ForegroundColor Cyan
Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State
