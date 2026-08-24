# Registers a per-user scheduled task that runs the watchdog every N minutes with no console popup.
param(
    [string]$TaskName = "GlitchTopstep_GatewayWatchdog",
    [int]$IntervalMinutes = 2
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdogVbs = Join-Path $PSScriptRoot "gateway-health-watchdog.vbs"
$watchdogPs1 = Join-Path $PSScriptRoot "gateway-health-watchdog.ps1"
if (-not (Test-Path $watchdogVbs)) {
    throw "Missing $watchdogVbs"
}
if (-not (Test-Path $watchdogPs1)) {
    throw "Missing $watchdogPs1"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# wscript + .vbs keeps the console fully hidden (powershell -WindowStyle Hidden still flashes).
$action = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "//B `"$watchdogVbs`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew `
    -Hidden

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
    -Description "Silent Glitch Topstep gateway health watchdog (no console popup)." |
    Out-Null

Write-Host "Registered scheduled task '$TaskName' (every ${IntervalMinutes}m, hidden via wscript)." -ForegroundColor Cyan
Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State
