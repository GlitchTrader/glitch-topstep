# PRAC soak preflight — Glitch Topstep (single_active_position)
param(
    [string]$GatewayUrl = "http://127.0.0.1:8790",
    [string]$Token = $env:GLITCH_LOCAL_TOKEN,
    [string]$EvidenceDir = "docs/evidence/PRAC-SOAK-2026-08-21"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Token) {
    $envFile = Join-Path (Join-Path $PSScriptRoot "..") ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^GLITCH_LOCAL_TOKEN=(.+)$') { $Token = $Matches[1].Trim() }
        }
    }
}
if (-not $Token) { throw "Set GLITCH_LOCAL_TOKEN or configure .env" }

$headers = @{ Authorization = "Bearer $Token" }
$health = Invoke-RestMethod -Uri "$GatewayUrl/health" -Headers $headers
$checks = @(
    [pscustomobject]@{ check = "gateway_version_0.2.2"; ok = ($health.compatibility.gateway_version -eq "0.2.2") },
    [pscustomobject]@{ check = "trading_mode_armed"; ok = ($health.trading_mode -eq "armed") },
    [pscustomobject]@{ check = "lifecycle_ready"; ok = ($health.lifecycle.state -eq "ready") },
    [pscustomobject]@{ check = "auth_not_degraded"; ok = (-not $health.invariant_metrics.auth_degraded) },
    [pscustomobject]@{ check = "state_complete"; ok = ($health.data_quality.state_complete -eq $true) },
    [pscustomobject]@{ check = "flat_start"; ok = ($health.protected_reduction.unprotected_open_quantity -eq 0) }
)

$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root $EvidenceDir
New-Item -ItemType Directory -Force -Path $out | Out-Null
$health | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $out "gateway-health-preflight.json")

$failed = @($checks | Where-Object { -not $_.ok })
$checks | Format-Table -AutoSize
if ($failed.Count -gt 0) {
    throw "PRAC preflight failed: $($failed.check -join ', ')"
}
Write-Host "PRAC preflight OK - evidence: $out" -ForegroundColor Green
