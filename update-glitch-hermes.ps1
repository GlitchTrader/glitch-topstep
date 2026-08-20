# Run after: hermes profile update glitch-topstep -y
# Restores Hermes-stripped .gitattributes, validates paired-contract.json, runs setup.

[CmdletBinding()]
param(
    [string]$ProfileRoot = (Join-Path $env:LOCALAPPDATA 'hermes\profiles\glitch-topstep'),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProfileRoot -PathType Container)) {
    throw "Glitch Topstep profile not found: $ProfileRoot"
}

$contractPath = Join-Path $ProfileRoot 'paired-contract.json'
if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
    throw "paired-contract.json missing in profile; reinstall glitch-topstep before setup."
}

$contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
$installName = [string]$contract.profile.hermes_install_name
if ([string]::IsNullOrWhiteSpace($installName)) {
    throw 'paired-contract.json missing profile.hermes_install_name'
}
if ($installName -ne 'glitch-topstep') {
    throw "Unexpected profile.hermes_install_name: $installName"
}

$gitAttributes = Join-Path $ProfileRoot '.gitattributes'
$expectedHash = [string]$contract.operations.gitattributes_sha256
$bytesHex = [string]$contract.operations.gitattributes_bytes_hex
if ([string]::IsNullOrWhiteSpace($expectedHash) -or [string]::IsNullOrWhiteSpace($bytesHex)) {
    throw 'paired-contract.json missing operations.gitattributes metadata'
}

if ($DryRun) {
    Write-Host "DryRun OK: profile=$ProfileRoot install=$installName contract=$contractPath"
    exit 0
}

$needsWrite = $true
if (Test-Path -LiteralPath $gitAttributes -PathType Leaf) {
    $currentHash = (Get-FileHash -LiteralPath $gitAttributes -Algorithm SHA256).Hash
    $needsWrite = $currentHash -ne $expectedHash
}

if ($needsWrite) {
    $bytes = for ($index = 0; $index -lt $bytesHex.Length; $index += 2) {
        [Convert]::ToByte($bytesHex.Substring($index, 2), 16)
    }
    [IO.File]::WriteAllBytes($gitAttributes, [byte[]]$bytes)
    Write-Host 'Restored .gitattributes'
}

$actualHash = (Get-FileHash -LiteralPath $gitAttributes -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw ".gitattributes checksum mismatch: $actualHash"
}

& powershell -ExecutionPolicy Bypass -File (Join-Path $ProfileRoot 'setup.ps1') -Profile $installName
