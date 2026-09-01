#!/usr/bin/env bash
# Sync glitch-topstep gateway GLITCH_TOPSTEP_PROMPT_VERSION to glitch-topstep-v9.
# Pairs with Hermes profile 0.1.31+ (glitch-topstep-v9).
set -euo pipefail

PROFILE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_PATH="${GATEWAY_PATH:-$HOME/Projects/glitch-topstep}"
PATCH_PATH="$PROFILE_ROOT/patches/glitch-topstep-v9-prompt-version.patch"
BRANCH_NAME="fix/glitch-topstep-v9-prompt-version"
CREATE_PR=0
MERGE_PR=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: sync-glitch-topstep-prompt-v9.sh [options]

Options:
  --gateway-path PATH   Local glitch-topstep clone (default: ~/Projects/glitch-topstep)
  --create-pr           Push branch and open a GitHub PR
  --merge-pr            Merge the open PR for this branch
  --skip-build          Skip npm run check/build
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-path)
      GATEWAY_PATH="$2"
      shift 2
      ;;
    --create-pr)
      CREATE_PR=1
      shift
      ;;
    --merge-pr)
      MERGE_PR=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$GATEWAY_PATH/.git" ]]; then
  echo "Gateway clone not found at $GATEWAY_PATH" >&2
  exit 1
fi
if [[ ! -f "$PATCH_PATH" ]]; then
  echo "Patch not found at $PATCH_PATH" >&2
  exit 1
fi

prompt_version_from_tree() {
  local file="$GATEWAY_PATH/src/domain/operator.ts"
  [[ -f "$file" ]] || return 0
  sed -n 's/.*GLITCH_TOPSTEP_PROMPT_VERSION *= *"\([^"]*\)".*/\1/p' "$file" | head -n1
}

origin_prompt_version() {
  git -C "$GATEWAY_PATH" show "origin/main:src/domain/operator.ts" 2>/dev/null \
    | sed -n 's/.*GLITCH_TOPSTEP_PROMPT_VERSION *= *"\([^"]*\)".*/\1/p' | head -n1
}

replace_v5_with_v9() {
  find "$GATEWAY_PATH" \( -name '*.ts' -o -name '*.mjs' -o -name '*.md' \) \
    ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.git/*' -print0 \
    | while IFS= read -r -d '' file; do
        if grep -q 'glitch-topstep-v5' "$file"; then
          sed -i 's/glitch-topstep-v5/glitch-topstep-v9/g' "$file"
          echo "$file"
        fi
      done
}

cd "$GATEWAY_PATH"
git fetch origin main
ORIGIN_VERSION="$(origin_prompt_version)"

if [[ "$ORIGIN_VERSION" == "glitch-topstep-v9" && "$CREATE_PR" -eq 0 && "$MERGE_PR" -eq 0 ]]; then
  echo "origin/main already has glitch-topstep-v9. Run: git checkout main && git pull origin main"
  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    npm run build
  fi
  exit 0
fi

git checkout main
git pull origin main
git checkout -B "$BRANCH_NAME"

LOCAL_VERSION="$(prompt_version_from_tree)"
echo "Local operator version: ${LOCAL_VERSION:-<missing>}"
echo "origin/main operator version: ${ORIGIN_VERSION:-<missing>}"

CHANGED=0
if [[ "$(find "$GATEWAY_PATH" \( -name '*.ts' -o -name '*.mjs' -o -name '*.md' \) ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.git/*' -exec grep -l 'glitch-topstep-v5' {} + 2>/dev/null | wc -l)" -gt 0 || "$LOCAL_VERSION" != "glitch-topstep-v9" ]]; then
  mapfile -t UPDATED < <(replace_v5_with_v9)
  if [[ "${#UPDATED[@]}" -gt 0 ]]; then
    echo "Updated ${#UPDATED[@]} file(s) to glitch-topstep-v9."
    CHANGED=1
  else
    echo "Attempting patch apply for any remaining drift..."
    if git apply --index "$PATCH_PATH"; then
      CHANGED=1
    fi
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  CHANGED=1
fi

if [[ "$CHANGED" -eq 1 ]]; then
  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    npm run check
  fi
  git add -A
  git commit -m "fix: accept glitch-topstep-v9 prompt version from Hermes profile 0.1.31

Bump GLITCH_TOPSTEP_PROMPT_VERSION to glitch-topstep-v9 so intents from
the paired Hermes profile pass gateway validation."
  echo "Committed gateway v9 pairing on branch $BRANCH_NAME"
else
  echo "No pairing changes needed in working tree."
fi

AHEAD="$(git rev-list --count "origin/main..HEAD" 2>/dev/null || echo 0)"
if [[ "$CREATE_PR" -eq 1 ]]; then
  if [[ "$AHEAD" -le 0 ]]; then
    if [[ "$ORIGIN_VERSION" == "glitch-topstep-v9" ]]; then
      echo "origin/main already includes v9 pairing; no PR to create."
      git checkout main
      git pull origin main
    else
      echo "No commits ahead of origin/main on $BRANCH_NAME." >&2
      exit 1
    fi
  else
    git push -u origin "$BRANCH_NAME"
    EXISTING="$(gh pr list --head "$BRANCH_NAME" --json url --jq '.[0].url' 2>/dev/null || true)"
    if [[ -n "$EXISTING" ]]; then
      echo "PR already exists: $EXISTING"
    else
      gh pr create --base main --head "$BRANCH_NAME" \
        --title "fix: accept glitch-topstep-v9 prompt version from Hermes profile 0.1.31" \
        --body "## Summary
- Bump \`GLITCH_TOPSTEP_PROMPT_VERSION\` to \`glitch-topstep-v9\` so intents from Hermes profile **0.1.31** pass gateway validation.

## Test plan
- [x] \`npm run check\`"
    fi
  fi
fi

if [[ "$MERGE_PR" -eq 1 ]]; then
  PR="$(gh pr list --head "$BRANCH_NAME" --json number --jq '.[0].number' 2>/dev/null || true)"
  if [[ -z "$PR" ]]; then
    if [[ "$ORIGIN_VERSION" == "glitch-topstep-v9" ]]; then
      echo "No open PR; origin/main already has v9 pairing."
    else
      echo "No open PR found for branch $BRANCH_NAME. Run with --create-pr first." >&2
      exit 1
    fi
  else
    gh pr merge "$PR" --squash --delete-branch
    git checkout main
    git pull origin main
    echo "Merged PR #$PR and updated local main."
  fi
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  npm run build
fi

echo
echo "Next: restart the gateway (stop PID on port 8790, then ./start.ps1 or npm start)"
echo "Verify: grep GLITCH_TOPSTEP_PROMPT_VERSION src/domain/operator.ts"
