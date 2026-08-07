# Registers a per-user logon task that starts the Glitch Topstep gateway (loopback :8790).
# Hermes_Gateway_* tasks start Hermes messaging — they do not start this ProjectX gateway.
param(
    [string]$TaskName = "GlitchTopstep_Gateway",
    [int]$DelaySeconds = 45
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $repoRoot "start.ps1"
if (-not (Test-Path $startScript)) {
    throw "Missing start.ps1 at $startScript"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -SkipBuild" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT${DelaySeconds}S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
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
    -Description "Start Glitch Topstep ProjectX gateway (127.0.0.1:8790) after user logon." |
    Out-Null

Write-Host "Registered scheduled task '$TaskName' (AtLogOn + ${DelaySeconds}s delay, -SkipBuild)." -ForegroundColor Cyan
Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult, NextRunTime
