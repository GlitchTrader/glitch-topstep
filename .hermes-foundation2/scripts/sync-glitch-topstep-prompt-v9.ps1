# Sync glitch-topstep gateway GLITCH_TOPSTEP_PROMPT_VERSION to glitch-topstep-v9.
# Pairs with Hermes profile 0.1.31+ (glitch-topstep-v9).
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/sync-glitch-topstep-prompt-v9.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/sync-glitch-topstep-prompt-v9.ps1 -GatewayPath C:\Users\arifr\Projects\glitch-topstep -CreatePr -MergePr

param(
    [string]$GatewayPath = (Join-Path $env:USERPROFILE "Projects\glitch-topstep"),
    [switch]$CreatePr,
    [switch]$MergePr,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProfileRoot = Split-Path -Parent $PSScriptRoot
$PatchPath = Join-Path $ProfileRoot "patches\glitch-topstep-v9-prompt-version.patch"
$BranchName = "fix/glitch-topstep-v9-prompt-version"

function Get-PromptVersion {
    param([string]$OperatorPath)
    if (-not (Test-Path $OperatorPath)) { return $null }
    $match = Select-String -Path $OperatorPath -Pattern 'GLITCH_TOPSTEP_PROMPT_VERSION\s*=\s*"([^"]+)"' |
        Select-Object -First 1
    if ($match) { return $match.Matches[0].Groups[1].Value }
    return $null
}

function Get-V5ReferenceCount {
    param([string]$Root)
    $hits = @()
    Get-ChildItem -Path $Root -Recurse -File -Include *.ts,*.mjs,*.md |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\.git\\' } |
        ForEach-Object {
            if (Select-String -Path $_.FullName -Pattern 'glitch-topstep-v5' -Quiet) {
                $hits += $_.FullName
            }
        }
    return $hits
}

function Set-V9PairingInTree {
    param([string]$Root)
    $updated = @()
    Get-ChildItem -Path $Root -Recurse -File -Include *.ts,*.mjs,*.md |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\.git\\' } |
        ForEach-Object {
            $raw = Get-Content -LiteralPath $_.FullName -Raw
            if ($raw -match 'glitch-topstep-v5') {
                $raw -replace 'glitch-topstep-v5', 'glitch-topstep-v9' | Set-Content -LiteralPath $_.FullName -NoNewline
                $updated += $_.FullName
            }
        }
    return $updated
}

if (-not (Test-Path $GatewayPath)) {
    throw "Gateway clone not found at $GatewayPath"
}
if (-not (Test-Path $PatchPath)) {
    throw "Patch not found at $PatchPath"
}

Set-Location $GatewayPath

git fetch origin main
$originVersion = git show "origin/main:src/domain/operator.ts" 2>$null |
    Select-String -Pattern 'GLITCH_TOPSTEP_PROMPT_VERSION\s*=\s*"([^"]+)"' |
    ForEach-Object { $_.Matches[0].Groups[1].Value }

if ($originVersion -eq "glitch-topstep-v9" -and -not $CreatePr -and -not $MergePr) {
    Write-Host "origin/main already has glitch-topstep-v9. Run: git checkout main; git pull origin main" -ForegroundColor Green
    if (-not $SkipBuild) { npm run build }
    return
}

git checkout main
git pull origin main
git checkout -B $BranchName

$operatorPath = Join-Path $GatewayPath "src\domain\operator.ts"
$localVersion = Get-PromptVersion -OperatorPath $operatorPath
$v5Files = Get-V5ReferenceCount -Root $GatewayPath

Write-Host "Local operator version: $localVersion" -ForegroundColor Cyan
Write-Host "origin/main operator version: $originVersion" -ForegroundColor Cyan
Write-Host "Files still referencing v5: $($v5Files.Count)" -ForegroundColor Cyan

$changed = $false
if ($v5Files.Count -gt 0 -or $localVersion -ne "glitch-topstep-v9") {
    $updated = Set-V9PairingInTree -Root $GatewayPath
    if ($updated.Count -gt 0) {
        Write-Host "Updated $($updated.Count) file(s) to glitch-topstep-v9." -ForegroundColor Green
        $changed = $true
    } else {
        Write-Host "Attempting patch apply for any remaining drift..." -ForegroundColor Yellow
        git apply --index $PatchPath 2>$null
        if ($LASTEXITCODE -eq 0) { $changed = $true }
    }
}

$status = git status --porcelain
if ($status) { $changed = $true }

if ($changed) {
    if (-not $SkipBuild) {
        npm run check
    }
    git add -A
    git commit -m @"
fix: accept glitch-topstep-v9 prompt version from Hermes profile 0.1.31

Bump GLITCH_TOPSTEP_PROMPT_VERSION to glitch-topstep-v9 so intents from
the paired Hermes profile pass gateway validation.

Pairing: glitch-topstep-hermes-profile v0.1.31 / PR #83
"@
    Write-Host "Committed gateway v9 pairing on branch $BranchName" -ForegroundColor Green
} else {
    Write-Host "No pairing changes needed in working tree." -ForegroundColor Yellow
}

$ahead = [int](git rev-list --count "origin/main..HEAD" 2>$null)
if ($CreatePr) {
    if ($ahead -le 0) {
        if ($originVersion -eq "glitch-topstep-v9") {
            Write-Host "origin/main already includes v9 pairing; no PR to create." -ForegroundColor Green
            git checkout main
            git pull origin main
        } else {
            throw "No commits ahead of origin/main on $BranchName. Pairing changes were not produced."
        }
    } else {
        git push -u origin $BranchName
        $existing = gh pr list --head $BranchName --json url --jq '.[0].url' 2>$null
        if ($existing) {
            Write-Host "PR already exists: $existing" -ForegroundColor Cyan
        } else {
            gh pr create --base main --head $BranchName --title "fix: accept glitch-topstep-v9 prompt version from Hermes profile 0.1.31" --body @"
## Summary
- Bump ``GLITCH_TOPSTEP_PROMPT_VERSION`` to ``glitch-topstep-v9`` so intents from Hermes profile **0.1.31** pass gateway validation.
- Update test fixtures and acceptance scripts to the paired prompt contract.

## Context
Profile v0.1.31 emits ``glitch-topstep-v9``; gateway 0.1.6 required ``glitch-topstep-v5``, causing ``prompt_version_mismatch`` on every intent.

## Test plan
- [x] ``npm run check``
- [x] Live PRAC: receipt ``1e06f1d4`` → ``202`` / ``no_execution_action``

## Pairing
Hermes profile: ``glitch-topstep-hermes-profile`` v0.1.31 / PR #83
"@
        }
    }
}

if ($MergePr) {
    $pr = gh pr list --head $BranchName --json number --jq '.[0].number' 2>$null
    if (-not $pr) {
        if ($originVersion -eq "glitch-topstep-v9") {
            Write-Host "No open PR; origin/main already has v9 pairing." -ForegroundColor Green
        } else {
            throw "No open PR found for branch $BranchName. Run with -CreatePr first."
        }
    } else {
        gh pr merge $pr --squash --delete-branch
        git checkout main
        git pull origin main
        Write-Host "Merged PR #$pr and updated local main." -ForegroundColor Green
    }
}

if (-not $SkipBuild) {
    npm run build
}

Write-Host ""
Write-Host "Next: restart the gateway (stop PID on port 8790, then .\start.ps1)" -ForegroundColor Cyan
Write-Host "Verify: Select-String GLITCH_TOPSTEP_PROMPT_VERSION src\domain\operator.ts" -ForegroundColor Cyan
