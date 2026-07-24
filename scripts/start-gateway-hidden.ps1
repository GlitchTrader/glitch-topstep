[CmdletBinding()]
param(
    [int]$Port = 8790
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repoRoot

$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listening.Count -gt 0) {
    exit 0
}

if (-not (Test-Path -LiteralPath '.env' -PathType Leaf)) {
    if (Test-Path -LiteralPath '.env.example' -PathType Leaf) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
    }
    else {
        throw 'Missing .env for Glitch Topstep gateway.'
    }
}

$dataDir = Join-Path $repoRoot 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$stdoutLog = Join-Path $dataDir 'gateway.stdout.log'
$stderrLog = Join-Path $dataDir 'gateway.stderr.log'

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @('src/server.js')

Start-Process `
    -FilePath $node `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    | Out-Null

Start-Sleep -Seconds 5
$ready = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($ready.Count -eq 0) {
    throw "Glitch Topstep gateway did not bind to port $Port. See $stdoutLog and $stderrLog"
}
