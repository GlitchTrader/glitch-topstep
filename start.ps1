# Inicia o gateway Glitch Topstep (shadow por defeito).
# Por defeito: processo node oculto com logs em data/. Use -Foreground para ver output nesta consola.
param(
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

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

npm run build

$nodeArgs = @("--enable-source-maps", "dist/src/index.js")
$port = if ($env:GLITCH_LOCAL_PORT) { [int]$env:GLITCH_LOCAL_PORT } else { 8790 }
$url = "http://127.0.0.1:$port"

if ($Foreground) {
    Write-Host "Gateway em $url (foreground)" -ForegroundColor Cyan
    & node @nodeArgs
    exit $LASTEXITCODE
}

$dataDir = if ($env:GLITCH_DATA_DIR) { $env:GLITCH_DATA_DIR } else { Join-Path $PSScriptRoot "data" }
if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
    $dataDir = Join-Path $PSScriptRoot $dataDir
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$stdoutLog = Join-Path $dataDir "gateway.stdout.log"
$stderrLog = Join-Path $dataDir "gateway.stderr.log"

Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
        if ($_.OwningProcess -gt 0) {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
Start-Sleep -Milliseconds 500

# ponytail: npm.cmd no Windows abre janela cmd; invocar node directamente evita popup
Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null

Write-Host "Gateway em background: $url" -ForegroundColor Cyan
Write-Host "Logs: $stdoutLog"
