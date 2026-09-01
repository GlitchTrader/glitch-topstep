# PRAC helper — restart gateway with optional kill point (clears acceptance stream gap).
param(
    [string]$KillPoint = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot | Out-Null
Set-Location ..

if (-not (Test-Path ".env")) {
    Write-Error "Missing .env"
}

Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $eq = $line.IndexOf("=")
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($name) { Set-Item -Path "env:$name" -Value $value }
}

Remove-Item env:GLITCH_ACCEPTANCE_STREAM_GAP -ErrorAction SilentlyContinue
if ($KillPoint) {
    Set-Item -Path env:GLITCH_KILL_POINT -Value $KillPoint
} else {
    Remove-Item env:GLITCH_KILL_POINT -ErrorAction SilentlyContinue
}

$port = if ($env:GLITCH_LOCAL_PORT) { [int]$env:GLITCH_LOCAL_PORT } else { 8790 }
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    $processId = [int]$listener.OwningProcess
    if ($processId -gt 0) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 2

if (-not $SkipBuild) {
    npm run build | Out-Null
} elseif (-not (Test-Path "dist\src\index.js")) {
    Write-Error "dist/src/index.js missing; run without -SkipBuild once."
}

$dataDir = if ($env:GLITCH_DATA_DIR) { $env:GLITCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\data" }
if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
    $dataDir = Join-Path (Get-Location) $dataDir
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$stdoutLog = Join-Path $dataDir "gateway.stdout.log"
$stderrLog = Join-Path $dataDir "gateway.stderr.log"
$nodeArgs = @("--enable-source-maps", "dist/src/index.js")

Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory (Get-Location) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null

Write-Output "started port=$port kill=$KillPoint"
