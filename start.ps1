# Inicia o gateway Glitch Topstep (shadow por defeito).
# Por defeito: processo node oculto com logs em data/. Use -Foreground para ver output nesta consola.
# -SkipBuild: usado no logon (task GlitchTopstep_Gateway); exige dist/ já compilado.
param(
    [switch]$Foreground,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Assert-GatewayRepoIdentity {
    # Refuse starts from nested/orphan worktrees or non-canonical checkouts.
    $root = (Resolve-Path $PSScriptRoot).Path
    $leaf = Split-Path $root -Leaf
    if ($root -match '(?i)[\\/]\.wt-[^\\/]+([\\/]|$)' -or $leaf -match '(?i)^\.wt-') {
        throw "Refusing start from worktree path '$root'. Use the canonical glitch-topstep checkout (not .wt-*)."
    }
    $pkgPath = Join-Path $root "package.json"
    $contractPath = Join-Path $root "release\paired-contract.json"
    if (-not (Test-Path -LiteralPath $pkgPath) -or -not (Test-Path -LiteralPath $contractPath)) {
        throw "Refusing start: missing package.json or release/paired-contract.json under '$root'."
    }
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    } catch {
        throw "Refusing start: unreadable package.json under '$root'."
    }
    if ([string]$pkg.name -ne "glitch-topstep") {
        throw "Refusing start: package.json name='$($pkg.name)' (expected glitch-topstep)."
    }
    $remote = (& git -C $root remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
        throw "Refusing start: git remote 'origin' missing under '$root'."
    }
    if ($remote -notmatch '(?i)glitchtrader/glitch-topstep(\.git)?\s*$') {
        throw "Refusing start: origin remote '$remote' is not GlitchTrader/glitch-topstep."
    }
}

Assert-GatewayRepoIdentity

$gatewayCommit = (& git -C $PSScriptRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gatewayCommit)) {
    throw "Refusing start: unable to resolve the gateway checkout commit."
}
$env:GLITCH_GATEWAY_COMMIT = $gatewayCommit
$env:GLITCH_GATEWAY_CHECKOUT = (Resolve-Path $PSScriptRoot).Path

if (-not (Test-Path ".env")) {
    Write-Error "Copie .env.example para .env e configure credenciais."
}

Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $eq = $line.IndexOf("=")
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($name) { Set-Item -Path "env:$name" -Value $value }
}

if (-not (Test-Path "node_modules")) {
    npm install
}

if ($SkipBuild) {
    if (-not (Test-Path "dist\src\index.js")) {
        Write-Error "dist/src/index.js missing; run without -SkipBuild once to compile."
    }
} else {
    npm run build
}

$nodeArgs = @("--enable-source-maps", "dist/src/index.js")
$port = if ($env:GLITCH_LOCAL_PORT) { [int]$env:GLITCH_LOCAL_PORT } else { 8790 }
$url = "http://127.0.0.1:$port"

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    $owners = @(
        $listeners |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object {
                $processId = [int]$_
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if ($process) {
                    "PID $processId ($($process.ProcessName))"
                }
                else {
                    "PID $processId"
                }
            }
    )
    $ownerText = if ($owners.Count -gt 0) { $owners -join ", " } else { "an unknown process" }
    throw "Port $port is already in use by $ownerText. Refusing to stop an unverified process. Stop the intended gateway explicitly or choose a different GLITCH_LOCAL_PORT."
}

if ($Foreground) {
    Write-Host "Gateway em $url (foreground)" -ForegroundColor Cyan
    & node @nodeArgs
    exit $LASTEXITCODE
}

$dataDir = if ($env:GLITCH_DATA_DIR) { $env:GLITCH_DATA_DIR } else { Join-Path $PSScriptRoot "data" }
if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
    $dataDir = Join-Path $PSScriptRoot $dataDir
}
if ($dataDir -match '(?i)(\\OneDrive\\|OneDrive -)') {
    Write-Warning "GLITCH_DATA_DIR is under OneDrive ($dataDir). SQLite WAL plus OneDrive sync can stall or corrupt the gateway. Prefer a path under $env:LOCALAPPDATA\glitch-topstep."
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$stdoutLog = Join-Path $dataDir "gateway.stdout.log"
$stderrLog = Join-Path $dataDir "gateway.stderr.log"

# ponytail: npm.cmd no Windows abre janela cmd; invocar node directamente evita popup
Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null

Write-Host "Gateway em background: $url" -ForegroundColor Cyan
Write-Host "Logs: $stdoutLog"
