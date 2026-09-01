# Canonical Windows update path for the installed glitch-topstep Hermes profile.
# Stops profile processes, strips VCS artifacts that break Hermes rmtree on update,
# runs `hermes profile update`, then setup.ps1.
[CmdletBinding()]
param(
    [string]$Profile = 'glitch-topstep',
    [switch]$ForceConfig
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profileRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:LOCALAPPDATA "hermes\profiles\$Profile")
)
if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    throw "Profile not found: $profileRoot"
}

function Enter-SafeUpdateWorkingDirectory {
    $currentRoot = [IO.Path]::GetFullPath((Get-Location).Path)
    if ($currentRoot.StartsWith($profileRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) `
        -or $currentRoot.Equals($profileRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning @"
Current directory is inside the profile ($currentRoot).
Hermes cannot replace locked folders on Windows. Switching to TEMP.
Run future updates from outside the profile tree, e.g.:
  cd $env:TEMP
  powershell -ExecutionPolicy Bypass -File "$profileRoot\scripts\safe-profile-update.ps1"
"@
        Set-Location $env:TEMP
    }
}

function Get-ProfilePythonProcesses {
    $escapedRoot = [regex]::Escape($profileRoot)
    return @(
        Get-CimInstance Win32_Process -Filter "name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -match [regex]::Escape($Profile) -or
                $_.CommandLine -match $escapedRoot
            }
    )
}

function Stop-ProfileProcesses {
    try {
        & hermes --profile $Profile gateway stop 2>$null | Out-Null
    }
    catch { }
    foreach ($process in Get-ProfilePythonProcesses) {
        Write-Host "Stopping PID $($process.ProcessId)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
}

function Remove-StaleProfileLock {
    param(
        [string]$LockPath,
        [switch]$Force
    )
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return $false
    }
    if (-not $Force -and (Get-ProfilePythonProcesses).Count -gt 0) {
        return $false
    }
    try {
        $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
        $owner = $raw | ConvertFrom-Json
        $ownerPid = [int]$owner.pid
        if ($ownerPid -gt 0 -and -not $Force) {
            $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if ($null -ne $ownerProcess) {
                return $false
            }
        }
    }
    catch {
        if (-not $Force) {
            return $false
        }
    }
    Remove-Item -LiteralPath $LockPath -Force
    Write-Host "Removed stale state\direct-cycle.lock"
    return $true
}

function Remove-StagingArtifacts {
    param([string]$Root)
    foreach ($name in @('.git', '.gitattributes')) {
        $path = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        if (Test-Path -LiteralPath $path -PathType Container) {
            cmd /c "attrib -R `"$path\*`" /S /D" 2>$null | Out-Null
        }
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $path) {
            throw "Could not remove staging artifact: $path"
        }
        Write-Host "Removed $name"
    }
    $lock = Join-Path $Root 'state\direct-cycle.lock'
    if (Test-Path -LiteralPath $lock -PathType Leaf) {
        Remove-Item -LiteralPath $lock -Force
        Write-Host 'Removed state\direct-cycle.lock'
    }
}

function Wait-ProfileQuiescent {
    param(
        [int]$TimeoutSeconds = 90
    )
    $lock = Join-Path $profileRoot 'state\direct-cycle.lock'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($process in Get-ProfilePythonProcesses) {
            Write-Host "Stopping lingering PID $($process.ProcessId)"
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if (Remove-StaleProfileLock -LockPath $lock) {
            return
        }
        if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) {
            return
        }
        Write-Host 'Waiting for direct-cycle.lock to clear...'
        Start-Sleep -Seconds 2
    }
    if ((Get-ProfilePythonProcesses).Count -eq 0) {
        if (Remove-StaleProfileLock -LockPath $lock -Force) {
            Write-Warning 'Removed orphaned direct-cycle.lock after quiescence timeout.'
            return
        }
    }
    throw "Profile still busy after ${TimeoutSeconds}s ($lock). Pause jobs with /pause_trading, wait one minute, then retry."
}

function Get-ProfileCronJobs {
    $jobsPath = Join-Path $profileRoot 'cron\jobs.json'
    if (-not (Test-Path -LiteralPath $jobsPath -PathType Leaf)) { return @() }
    $document = Get-Content -LiteralPath $jobsPath -Raw | ConvertFrom-Json
    return @($document.jobs)
}

function Get-ProfileCronJobIds {
    return @(Get-ProfileCronJobs | ForEach-Object { [string]$_.id })
}

function Save-ProfileCronEnabledState {
    $state = @{}
    foreach ($job in Get-ProfileCronJobs) {
        $state[[string]$job.id] = [bool]$job.enabled
    }
    return $state
}

function Restore-ProfileCronEnabledState {
    param([hashtable]$State)
    foreach ($entry in $State.GetEnumerator()) {
        if ($entry.Value) {
            & hermes --profile $Profile cron resume $entry.Key 2>$null | Out-Null
        }
    }
}

function Set-ProfileCronJobsPaused {
    param([bool]$Paused)
    foreach ($jobId in Get-ProfileCronJobIds) {
        if ($Paused) {
            & hermes --profile $Profile cron pause $jobId 2>$null | Out-Null
        }
        else {
            & hermes --profile $Profile cron resume $jobId 2>$null | Out-Null
        }
    }
}

function Get-RecordedSource {
    $yaml = Join-Path $profileRoot 'distribution.yaml'
    foreach ($line in Get-Content -LiteralPath $yaml) {
        if ($line -match '^source:\s*(.+)$') {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    throw 'distribution.yaml has no source: field — reinstall from GitHub first.'
}

function Ensure-HermesDistributionPatch {
    $hermesCommand = Get-Command hermes -ErrorAction Stop
    $python = Join-Path (Split-Path $hermesCommand.Source -Parent) 'python.exe'
    $patchScript = Join-Path $profileRoot 'scripts\ensure_hermes_distribution_patch.py'
    if (-not (Test-Path -LiteralPath $patchScript -PathType Leaf)) {
        $patchScript = Join-Path $PSScriptRoot 'ensure_hermes_distribution_patch.py'
    }
    if (-not (Test-Path -LiteralPath $patchScript -PathType Leaf)) {
        throw @"
ensure_hermes_distribution_patch.py is missing. Install profile v0.1.13+ first:
  hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --name glitch-topstep --force -y
"@
    }
    $output = & $python $patchScript 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Could not ensure Hermes distribution patch: $($output.Trim())"
    }
    if ($output.Trim()) {
        Write-Host $output.Trim()
    }
}

$source = Get-RecordedSource
if ($source -match '^[A-Za-z]:\\' -or $source -match '^/') {
    Write-Warning @"
Recorded source is a local path ($source).
Hermes copies .git from local paths and Windows updates fail.
Reinstall once from GitHub, then use this script again:
  hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --name glitch-topstep --force -y
"@
    throw 'Refusing to update from a local-path distribution source.'
}

Write-Host "Updating profile '$Profile' from $source"
Enter-SafeUpdateWorkingDirectory
$cronEnabledBefore = Save-ProfileCronEnabledState
Set-ProfileCronJobsPaused -Paused $true
Start-Sleep -Seconds 5
Stop-ProfileProcesses
Wait-ProfileQuiescent
Remove-StagingArtifacts -Root $profileRoot
Ensure-HermesDistributionPatch

Set-Location $env:TEMP
$updateArgs = @('profile', 'update', $Profile, '-y')
if ($ForceConfig) { $updateArgs += '--force-config' }
& hermes @updateArgs
if ($LASTEXITCODE -ne 0) {
    throw "hermes profile update failed with exit code $LASTEXITCODE"
}

Remove-StagingArtifacts -Root $profileRoot

$setup = Join-Path $profileRoot 'setup.ps1'
& powershell -ExecutionPolicy Bypass -File $setup
if ($LASTEXITCODE -ne 0) {
    throw "setup.ps1 failed with exit code $LASTEXITCODE"
}

Restore-ProfileCronEnabledState -State $cronEnabledBefore

Write-Host "Profile '$Profile' updated successfully."
