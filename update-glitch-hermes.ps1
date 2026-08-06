# Run after: hermes profile update glitch -y
# Fixes missing .gitattributes from Hermes profile update, then runs setup.

$ErrorActionPreference = 'Stop'

$profileRoot = Join-Path $env:LOCALAPPDATA 'hermes\profiles\glitch'
$gitAttributes = Join-Path $profileRoot '.gitattributes'
$expectedHash = '705FD4D6451A31D36B3DF7DE96F83F30AC976C9B4A6D1E51671D8E2F33E2D0DA'
$glitchData = 'C:\Users\arifr\OneDrive\Documentos\NinjaTrader 8\GlitchData'

if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    throw "Glitch profile not found: $profileRoot"
}

$needsWrite = $true
if (Test-Path -LiteralPath $gitAttributes -PathType Leaf) {
    $currentHash = (Get-FileHash -LiteralPath $gitAttributes -Algorithm SHA256).Hash
    $needsWrite = $currentHash -ne $expectedHash
}

if ($needsWrite) {
    $bytes = [byte[]]@(0x2A, 0x20, 0x2D, 0x74, 0x65, 0x78, 0x74, 0x0A)
    [IO.File]::WriteAllBytes($gitAttributes, $bytes)
    Write-Host "Restored .gitattributes"
}

$actualHash = (Get-FileHash -LiteralPath $gitAttributes -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw ".gitattributes checksum mismatch: $actualHash"
}

& powershell -ExecutionPolicy Bypass -File (Join-Path $profileRoot 'setup.ps1') -GlitchData $glitchData
