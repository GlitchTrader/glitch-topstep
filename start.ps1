$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path -LiteralPath ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    throw "Created .env from .env.example — set GLITCH_TOPSTEP_LOCAL_TOKEN to match the Hermes profile, then rerun."
}
& (Join-Path $PSScriptRoot "scripts\start-gateway-hidden.ps1")
