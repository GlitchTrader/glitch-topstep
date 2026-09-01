# Glitch Topstep Hermes Profile

Hermes cognition, skills, learning workers, and operator controls for [`GlitchTrader/glitch-topstep`](https://github.com/GlitchTrader/glitch-topstep).

```text
ProjectX / TopstepX
        │
        ▼
Glitch Topstep gateway (separate repo, must be running)
        │ authenticated sanitized packet
        ▼
Hermes profile: glitch-topstep  (this repo)
  observation · judgment · decision · review · learning
        │ strict glitch.intent.v3
        ▼
Glitch Topstep gateway
  factual verification · execution · receipts
```

**Status:** Experimental. Fresh installs create jobs **paused**. No profitability, payout, unattended-operation, or live-readiness claim.

**Authority:** Hermes decides. Glitch verifies. This profile never holds ProjectX credentials. See [`docs/AUTHORITY.md`](docs/AUTHORITY.md).

Current work: [`docs/ledger/ledger.json`](docs/ledger/ledger.json). Gateway work: [`glitch-topstep/docs/ledger/ledger.json`](https://github.com/GlitchTrader/glitch-topstep/blob/main/docs/ledger/ledger.json).

---

## Prerequisites

- **Windows** with the **glitch-topstep** gateway installed and running in shadow (or disabled)
- **Hermes 0.18.2+**
- **OpenAI Codex OAuth** on the `glitch-topstep` profile (or another explicitly configured provider)
- **Same local bearer token** in gateway `.env` and profile `.env`
- **Python 3.12+** — for developing and testing this repo

---

## Install (operators)

Gateway first, then profile:

```powershell
# 1. Gateway — see glitch-topstep README
cd glitch-topstep
npm start

# 2. Profile
hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --alias
hermes -p glitch-topstep auth add openai-codex --type oauth
notepad "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\.env"
```

Minimum profile `.env`:

```text
GLITCH_TOPSTEP_LOCAL_TOKEN=<same as gateway GLITCH_LOCAL_TOKEN>
GLITCH_TOPSTEP_OPERATOR_TOKEN=<same as gateway GLITCH_OPERATOR_TOKEN>
```

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\setup.ps1"
```

In Hermes:

```text
/topstep_status
/trade
```

`/trade` enables scheduled cognition only. Gateway execution mode (`disabled` / `shadow` / `armed`) is set **only** in the gateway repo.

### Update installed profile (Windows)

Use the safe updater — it stops profile processes, removes `.git` artifacts that break Hermes on Windows, runs `hermes profile update`, then `setup.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\scripts\safe-profile-update.ps1"
```

**Always install and update from the GitHub source**, never from a local clone path. Local-path installs copy `.git` into the profile and future updates fail with `PermissionError` on Windows.

```powershell
# First install only — use GitHub URL
hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --name glitch-topstep --alias
```

Manual fallback (not recommended on Windows):

```powershell
hermes profile update glitch-topstep
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\setup.ps1"
```

Auth, `.env`, sessions, memory, state, and job pause/enabled state are preserved.

---

## Clone and develop (contributors)

```powershell
git clone https://github.com/GlitchTrader/glitch-topstep-hermes-profile.git
cd glitch-topstep-hermes-profile
cp .env.EXAMPLE .env
python -m unittest discover -s tests -p 'test_*.py'
```

CI runs `py_compile` on scripts/plugins plus the same unittest suite on every push/PR.

To test against a live gateway, point `.env` at your local instance and ensure `GLITCH_TOPSTEP_LOCAL_TOKEN` matches. The `flatten-all` command additionally requires the separate `GLITCH_TOPSTEP_OPERATOR_TOKEN`; the local read/intent token is intentionally insufficient for operator controls.

### Edit → verify → commit → push

```powershell
python -m unittest discover -s tests -p 'test_*.py'
git checkout -b agent/your-topic
git add <files>
git commit -m "docs: short description"
git push -u origin agent/your-topic
gh pr create
```

After merging profile changes operators care about, bump `distribution.yaml`, regenerate `SHA256SUMS`, and remind users to run `safe-profile-update.ps1`:

```powershell
python scripts/regenerate_sha256sums.py
```

### Where to edit

| Area | Path |
|------|------|
| Operator doctrine | `SOUL.md`, `docs/AUTHORITY.md` |
| Decision cycle | `scripts/run-topstep-cycle.py`, `scripts/launch-topstep-cycle.py` |
| Intent skill | `skills/topstep-build-intent/SKILL.md` |
| Hermes chat controls | `plugins/topstep-control/` |
| Learning workers | `scripts/run-topstep-learning.py`, `skills/topstep-*` |
| Tests | `tests/test_*.py` |

### Never commit

`.env`, Hermes `state/`, sessions, memory, logs, or operator-specific ledgers.

---

## Operator controls

| Command | Effect |
|---------|--------|
| `/topstep_status` | Gateway health, mode, account visibility, job state |
| `/trade` | Resume minute operator + learning launcher |
| `/pause_trading` | Pause jobs; does not cancel provider orders |
| `/flatten_all` | Pause jobs + submit one risk-reducing `EXIT` via gateway |
| `/long`, `/short` | Queue one operator-directed experiment for next cycle |
| `/bias_long`, `/bias_short`, `/bias_neutral` | Soft one-cycle advisory |

---

## Doctrine (aligned with gateway + NinjaTrader learnings)

- Packet fields are **evidence**, not hidden strategy gates.
- Native MTF bars, rolling tape, and bounded DOM are described in `SOUL.md` — Hermes interprets; Glitch does not veto cognition on incomplete history alone.
- **Duplicate `intent_id` retries** are gateway-owned replay. Do not resubmit a changed body under the same UUID or bypass reconciliation with timers.
- Cognitive overlays stay **proposed** until explicitly activated (`GLITCH_TOPSTEP_AUTO_ACTIVATE_OVERLAY=false` by default).

The current gateway implements one-account/contract scope, tranche-aware `MOVE_STOP`/`MOVE_TP`, partial `EXIT`, native protection/rearm, durable mutation ownership, and restart reconciliation in source and deterministic fixtures. Hermes may use only actions advertised in `execution.supported_actions`. Real ProjectX mutation acceptance beyond current operator evidence, historical identity retention, sustained evidence-rate measurement, canonical outcome learning input, and operator beta promotion remain open in the gateway ledger; the profile must not overstate those external proofs. There is still no native TP1/TP2/TP3 multi-leg entry beyond a single `take_profit_1` bracket.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [`docs/AUTHORITY.md`](docs/AUTHORITY.md) | Cognition vs validation boundary |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Profile layout and workers |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Startup order, incidents |
| [`docs/OUTCOME-CONTRACT.md`](docs/OUTCOME-CONTRACT.md) | Learning input contract |
| [`docs/ledger/ledger.json`](docs/ledger/ledger.json) | Profile rail (`RAIL-*`) |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Historical handoff notes |

Gateway README (install, API, contributing): [glitch-topstep](https://github.com/GlitchTrader/glitch-topstep).
