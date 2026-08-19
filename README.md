# Glitch Topstep

Topstep-first AI trading gateway on the official ProjectX / TopstepX API.

```text
ProjectX market and account truth
             │
             ▼
Glitch Topstep (this repo)
  normalize · persist evidence · calculate · verify · execute · reconcile · recover
             │ sanitized evidence packet
             ▼
Hermes Topstep operator  →  glitch.intent.v2  →  Glitch Topstep → ProjectX orders
```

Companion cognition: [`GlitchTrader/glitch-topstep-hermes-profile`](https://github.com/GlitchTrader/glitch-topstep-hermes-profile).

**Status:** Experimental, **shadow by default**, not live-ready. Promotion gates: [`docs/PARITY.md`](docs/PARITY.md). Native design: [`docs/TOPSTEP-NATIVE.md`](docs/TOPSTEP-NATIVE.md). Current work: [`docs/ledger/ledger.json`](docs/ledger/ledger.json).

**Authority:** Hermes decides. Glitch verifies. ProjectX owns venue truth. See [`docs/AUTHORITY.md`](docs/AUTHORITY.md).

---

## Prerequisites

- **Windows** personal machine (Topstep requirement; no VPS)
- **Node.js 22+**
- **Git** + GitHub access to `GlitchTrader/glitch-topstep`
- **TopstepX + ProjectX API subscription** — required for real shadow integration; optional for offline dev
- **Hermes 0.18.2+** — only if running autonomous cognition via the companion profile

---

## Clone and install

```powershell
git clone https://github.com/GlitchTrader/glitch-topstep.git
cd glitch-topstep
cp .env.example .env
npm install
npm run check
```

`npm run check` runs `tsc` and the full test suite. **Run it before every push** — same gate as [CI](.github/workflows/ci.yml).

### Minimum `.env` (code-only / no ProjectX)

```text
GLITCH_LOCAL_TOKEN=<long-random-string>
GLITCH_OPERATOR_TOKEN=<different-long-random-string>
GLITCH_TRADING_MODE=shadow
GLITCH_DATA_DIR=./data
```

### Shadow integration (real account)

Fill `PROJECTX_USERNAME`, `PROJECTX_API_KEY`, `GLITCH_ACCOUNT_ID`, `GLITCH_ACCOUNT_NAME`, `GLITCH_CONTRACT_ID`, `GLITCH_INSTRUMENT` from [`.env.example`](.env.example). Keep `GLITCH_TRADING_MODE=shadow` until [`docs/OPERATIONS.md`](docs/OPERATIONS.md) acceptance is complete.

---

## Run

```powershell
.\start.ps1              # background (hidden node, logs in data/)
.\start.ps1 -Foreground  # interactive console
```

Or manually:

```powershell
npm start
```

Binds to a numeric loopback address only. `GLITCH_LOCAL_HOST` accepts `127.0.0.1` or `::1`; wildcard, hostname, LAN, and public binds are rejected before service startup. Never expose the gateway to LAN or internet.

```powershell
curl http://127.0.0.1:8790/health
curl -H "Authorization: Bearer $env:GLITCH_LOCAL_TOKEN" http://127.0.0.1:8790/packet
```

### Local API

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | none | Operational, recovery, evidence, history, bar, order-flow status |
| `GET /state` | bearer | Current venue snapshot |
| `GET /packet` | bearer | Decision packet + market observation + order flow |
| `GET /evidence` | bearer | Provider evidence journal (`limit` ≤ 1000) |
| `GET /ownership` | bearer | Entry/fill identity (protection ownership still P0) |
| `POST /intent` | bearer | Strict `glitch.intent.v2` execution |

### Data stores

```text
data/glitch-topstep.sqlite      execution identity and recovery (WAL, FULL sync)
data/projectx-evidence.sqlite   provider evidence/history (bounded market retention)
```

Offline replay: `npm run replay:evidence -- --help`

---

## Hermes profile (optional)

Start the gateway in **shadow** first, then in the [companion profile repo](https://github.com/GlitchTrader/glitch-topstep-hermes-profile):

```powershell
hermes profile install github.com/GlitchTrader/glitch-topstep-hermes-profile --alias
hermes -p glitch-topstep auth add openai-codex --type oauth
notepad "$env:LOCALAPPDATA\hermes\profiles\glitch-topstep\.env"
```

Set `GLITCH_TOPSTEP_LOCAL_TOKEN` to the **same** value as gateway `GLITCH_LOCAL_TOKEN`. Run `setup.ps1`, then `/topstep_status` and `/trade` in Hermes.

`POST /control` and `GET /control` require the distinct `GLITCH_OPERATOR_TOKEN`; the model token is rejected for operator controls.

The profile never receives ProjectX credentials.

---

## Contributing (Cursor or any editor)

### Read first

1. [`docs/AUTHORITY.md`](docs/AUTHORITY.md) — what Glitch may and may not enforce
2. [`docs/PARITY.md`](docs/PARITY.md) — capability matrix and promotion rule
3. [`docs/ledger/ledger.json`](docs/ledger/ledger.json) — canonical work queue (`TS-*` ids)

`docs/ROADMAP.md` is durable intent; the **ledger** is current task state.

### Edit → verify → commit → push

```powershell
# edit src/ or tests/
npm run check
git checkout -b agent/your-topic    # optional; main also accepts direct pushes if team agrees
git add <files>
git commit -m "feat: short description"
git push -u origin agent/your-topic
gh pr create                        # or push main
```

### Where to edit

| Area | Path |
|------|------|
| Intent parsing | `src/domain/intents.ts` |
| UUID + body-hash ownership | `src/domain/intent-body-hash.ts`, `src/storage/sqlite-execution-store.ts` |
| Execution / receipts | `src/execution/coordinator.ts`, `src/execution/recovery.ts` |
| ProjectX client / streams | `src/projectx/` |
| Evidence journal | `src/projectx/provider-event-recorder.ts`, `src/storage/sqlite-provider-evidence-store.ts` |
| Decision packets | `src/hermes/packet-builder.ts` |
| Tape / depth / MTF | `src/market/` |
| Tests | `tests/*.test.ts` — add coverage for every behavior change |

### Never commit

`.env`, API keys, JWTs, `data/` runtime stores, or sanitized fixtures containing secrets.

### Suggested next work (ledger)

| ID | Title | Status |
|----|-------|--------|
| TS-R4-00 | Nonterminal intents until native bracket proof | ready |
| TS-R1-01 | Process-kill recovery fixtures | ready |
| TS-R4-01 | Provider bracket ownership from explicit IDs | backlog (P0) |
| TS-R2-01 | Real ProjectX auth in shadow | blocked (needs API subscription) |

Recent NT parity shipped: **TS-R1-05** atomic UUID + body-hash claim.

---

## Safety rules

1. Default **`GLITCH_TRADING_MODE=shadow`** — no live orders without operator approval and runtime evidence.
2. **`armed`** requires `GLITCH_ARMED_ACK=I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY` — not a readiness claim.
3. Bind only to numeric loopback `127.0.0.1` or `::1`; invalid hosts fail before provider activity.
4. **ProjectX credentials stay in this repo's `.env`** — never in Hermes, logs, or git.
5. **Green tests ≠ live-ready.** See promotion rule in [`docs/PARITY.md`](docs/PARITY.md).
6. **Not NinjaTrader** — do not import CopyEngine, Apex, or replication code. Behavioral contracts only via PARITY.

### Core execution doctrine

```text
parse → redact and persist evidence → mutate state   (never the reverse)

Glitch intent → providerOrderId + customTag → order evidence → trade.orderId match
```

Ambiguous provider transport stays **nonterminal** until reconciliation — no wall-clock resubmission. Duplicate intent UUID retries replay immutable receipts; same UUID with different body returns `intent_body_conflict`.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [`docs/AUTHORITY.md`](docs/AUTHORITY.md) | Roles, permitted rejection, forbidden policy |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design |
| [`docs/TOPSTEP-NATIVE.md`](docs/TOPSTEP-NATIVE.md) | Topstep-native design principles (not NT parity) |
| [`docs/TOPSTEP-POLICY.md`](docs/TOPSTEP-POLICY.md) | Loss-floor models and policy evidence |
| [`docs/PARITY.md`](docs/PARITY.md) | Capability matrix and promotion gates |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Shadow acceptance, armed ack, incidents |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Trust boundaries |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Evidence-gated roadmap |
| [`docs/ledger/ledger.json`](docs/ledger/ledger.json) | Current work authority |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Historical Codex handoff notes |
