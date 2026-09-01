[CmdletBinding()]
param(
    [string]$Profile = 'glitch-topstep',
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profileRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "hermes\profiles\$Profile"))
$supervisor = Join-Path $profileRoot 'state\supervisor'

if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    throw "Profile root not found: $profileRoot"
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing reset target outside profile root: $fullPath"
    }
    return $fullPath
}

$preview = [ordered]@{
    schema_version = 'glitch.topstep.epoch_reset.v1'
    mode = if ($Apply) { 'apply' } else { 'preview' }
    profile = $Profile
    target = $supervisor
    preserved = @(
        'Hermes profile configuration, SOUL, and skills',
        'Gateway state outside supervisor',
        'Minute frames and operational logs unless under supervisor'
    )
    destroyed = @(
        'supervisor learning artifacts (plans, guidance, episodes, overlays)'
    )
}

if (-not $Apply) {
    $preview | ConvertTo-Json -Depth 4
    Write-Host ''
    Write-Host 'Re-run with -Apply to clear state/supervisor after confirmation.'
    return
}

$confirmation = Read-Host "Clear supervisor state under $supervisor? Type RESET to confirm"
if ($confirmation -ne 'RESET') {
    throw 'Reset cancelled.'
}

if (Test-Path -LiteralPath $supervisor -PathType Container) {
    $target = Assert-ChildPath -Path $supervisor -Root $profileRoot
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $supervisor | Out-Null

[ordered]@{
    schema_version = 'glitch.topstep.epoch_reset.v1'
    mode = 'applied'
    reset_utc = [datetime]::UtcNow.ToString('o')
    profile = $Profile
    supervisor_cleared = $true
} | ConvertTo-Json -Depth 3
