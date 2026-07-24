[CmdletBinding()]
param(
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $repoRoot 'scripts\start-gateway-hidden.ps1'
$serviceDir = Join-Path $repoRoot 'gateway-service'
$taskName = 'Glitch_Topstep_Gateway'
$startupName = 'Glitch_Topstep_Gateway.vbs'

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Launcher not found: $launcher"
}

New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

$vbsPath = Join-Path $serviceDir $startupName
$vbs = @"
' Glitch Topstep Node gateway - hidden autostart launcher
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$launcher""", 0, False
"@
Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding ASCII

$startupFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Force -Path $startupFolder | Out-Null
$startupEntry = Join-Path $startupFolder $startupName
Copy-Item -LiteralPath $vbsPath -Destination $startupEntry -Force

$taskInstalled = $false
$taskError = ''
try {
    $existing = schtasks /Query /TN $taskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        schtasks /Delete /TN $taskName /F | Out-Null
    }
    $tr = 'wscript.exe "' + $vbsPath + '"'
    schtasks /Create /F /TN $taskName /SC ONLOGON /RL LIMITED /DELAY 0000:30 /TR $tr | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $taskInstalled = $true
    }
}
catch {
    $taskError = $_.Exception.Message
}

if ($StartNow) {
    & $launcher
}

[ordered]@{
    schema_version = 'glitch.topstep.gateway_autostart.v1'
    repo_root = $repoRoot
    startup_entry = $startupEntry
    vbs_launcher = $vbsPath
    scheduled_task = $taskName
    scheduled_task_installed = $taskInstalled
    scheduled_task_error = $taskError
    start_now = [bool]$StartNow
} | ConvertTo-Json -Depth 4
