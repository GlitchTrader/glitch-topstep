# Observa ciclos Hermes + receipts do gateway (uma linha por poll).
param(
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'hermes\profiles\glitch-topstep\state'),
    [string]$GatewayUrl = 'http://127.0.0.1:8790',
    [int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Continue'
$decisionsPath = Join-Path $StateRoot 'decisions.jsonl'
$receiptsPath = Join-Path $StateRoot 'receipts.jsonl'
$workerPath = Join-Path $StateRoot 'supervisor\direct-worker-status.json'
$profileEnv = Join-Path (Split-Path $StateRoot -Parent) '.env'

function Read-LastJsonLine {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $line = Get-Content -LiteralPath $Path -Tail 1 -ErrorAction SilentlyContinue
    if (-not $line) { return $null }
    try { return ($line | ConvertFrom-Json) } catch { return $null }
}

function Read-ProfileToken {
    if (-not (Test-Path -LiteralPath $profileEnv)) { return $null }
    foreach ($line in Get-Content -LiteralPath $profileEnv) {
        if ($line -match '^\s*GLITCH_TOPSTEP_LOCAL_TOKEN\s*=\s*(.+)\s*$') {
            return $Matches[1].Trim()
        }
    }
    return $null
}

$token = Read-ProfileToken
$lastFingerprint = $null

Write-Host "watch-topstep | state=$StateRoot | gateway=$GatewayUrl | interval=${IntervalSeconds}s | Ctrl+C para sair"
Write-Host ('-' * 100)

while ($true) {
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

    $mode = 'unreachable'
    $contracts = '?'
    try {
        $health = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec 5
        $mode = [string]$health.trading_mode
    } catch { }

    if ($token) {
        try {
            $state = Invoke-RestMethod -Uri "$GatewayUrl/state" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
            $contracts = [string]$state.account.total_open_contracts
        } catch { }
    }

    $decision = Read-LastJsonLine $decisionsPath
    $receipt = Read-LastJsonLine $receiptsPath
    $worker = Read-LastJsonLine $workerPath

    $action = if ($decision?.intent?.action) { [string]$decision.intent.action } else { '-' }
    $decisionUtc = if ($decision?.recorded_utc) { [string]$decision.recorded_utc } else { '-' }
    $prompt = if ($decision?.intent?.prompt_version) { [string]$decision.intent.prompt_version } else { '-' }

    $receiptStatus = if ($receipt?.result?.body?.status) { [string]$receipt.result.body.status } else { '-' }
    $receiptCode = if ($receipt?.result?.body?.code) { [string]$receipt.result.body.code } else { '-' }
    $receiptHttp = if ($receipt?.result?.http_status) { [string]$receipt.result.http_status } else { '-' }
    $receiptUtc = if ($receipt?.recorded_utc) { [string]$receipt.recorded_utc } else { '-' }

    $workerStatus = if ($worker?.status) { [string]$worker.status } else { 'unknown' }

    $fingerprint = "$decisionUtc|$action|$receiptUtc|$receiptStatus|$receiptCode"
    $suffix = if ($fingerprint -eq $lastFingerprint) { ' (sem mudança)' } else { '' }
    $lastFingerprint = $fingerprint

    Write-Host (
        "$now | mode=$mode | pos=$contracts | action=$action | prompt=$prompt | "
        + "receipt=$receiptHttp/$receiptStatus/$receiptCode | decision_utc=$decisionUtc | "
        + "receipt_utc=$receiptUtc | worker=$workerStatus$suffix"
    )

    Start-Sleep -Seconds $IntervalSeconds
}
