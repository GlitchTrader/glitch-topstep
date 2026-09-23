# Observa ciclos Hermes + receipts do gateway (uma linha por poll).
# Compatível com Windows PowerShell 5.1.
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

function Get-NestedString {
    param(
        [object]$Object,
        [string[]]$Path,
        [string]$Default = '-'
    )
    $current = $Object
    foreach ($segment in $Path) {
        if ($null -eq $current) { return $Default }
        $current = $current.$segment
    }
    if ($null -eq $current -or [string]::IsNullOrEmpty([string]$current)) {
        return $Default
    }
    return [string]$current
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
            if ($null -ne $state.totalOpenContracts) {
                $contracts = [string]$state.totalOpenContracts
            } elseif ($null -ne $state.total_open_contracts) {
                $contracts = [string]$state.total_open_contracts
            } elseif ($state.instrumentOpenContracts -ne $null) {
                $contracts = [string]$state.instrumentOpenContracts
            }
        } catch { }
    }

    $decision = Read-LastJsonLine $decisionsPath
    $receipt = Read-LastJsonLine $receiptsPath
    $worker = Read-LastJsonLine $workerPath

    $action = Get-NestedString $decision @('intent', 'action')
    $decisionUtc = Get-NestedString $decision @('recorded_utc')
    $prompt = Get-NestedString $decision @('intent', 'prompt_version')

    $receiptStatus = Get-NestedString $receipt @('result', 'body', 'status')
    $receiptCode = Get-NestedString $receipt @('result', 'body', 'code')
    $receiptHttp = Get-NestedString $receipt @('result', 'http_status')
    $receiptUtc = Get-NestedString $receipt @('recorded_utc')

    $workerStatus = Get-NestedString $worker @('status') 'unknown'

    $fingerprint = "$decisionUtc|$action|$receiptUtc|$receiptStatus|$receiptCode"
    $suffix = ''
    if ($fingerprint -eq $lastFingerprint) { $suffix = ' (sem mudanca)' }
    $lastFingerprint = $fingerprint

    $line = "$now | mode=$mode | pos=$contracts | action=$action | prompt=$prompt | receipt=$receiptHttp/$receiptStatus/$receiptCode | decision_utc=$decisionUtc | receipt_utc=$receiptUtc | worker=$workerStatus$suffix"
    Write-Host $line

    Start-Sleep -Seconds $IntervalSeconds
}
