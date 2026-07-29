# Glitch Topstep Stability Lock Audit

**Date:** 2026-07-29  
**Scope:** direct ProjectX/TopstepX gateway and its companion Hermes profile boundary  
**Posture:** source-first architecture review, white-hat local attack review, process/provider failure wargame, executable handoff  
**Authority:** `docs/ledger/ledger.json` remains the canonical work ledger

## Executive verdict

Glitch Topstep has the cleanest durable execution foundation in the current Glitch portfolio:

- intent identity is persisted before mutation;
- body hashes distinguish replay from conflict;
- SQLite uses WAL and FULL synchronous durability for execution authority;
- a durable outbox and entry latch block duplicate exposure;
- same-body duplicate delivery replays one receipt;
- ambiguous provider transport stays unresolved instead of authorizing a retry;
- historical order recovery requires a unique custom tag and full order identity;
- the execution coordinator serializes local mutations;
- deterministic tests exercise one hundred concurrent identical intents.

That foundation is promising, but it is not yet provider-operational proof.

The current highest-risk gaps are:

1. process-kill and Windows restart evidence;
2. REST submission being treated too close to terminal success;
3. explicit provider bracket-child ownership;
4. real ProjectX payload/stream/reconnect evidence;
5. local startup and bind authority defects;
6. one exact supported Windows service/start/stop contract.

The correct near-term positioning is:

> Experimental, shadow by default, durable local execution architecture under provider verification.

Do not call it live-ready, unattended, or profitable.

## North star

A Topstep-first gateway whose intent identity, provider evidence, account state, protective-order ownership, and recovery survive duplicate delivery, transport ambiguity, process failure, reconnect, and Windows restart.

## Current weekly outcome

1. Merge the narrow local startup security corrections after exact-head checks.
2. Execute deterministic process-kill and restart fixtures for `TS-R1-01`, `TS-R1-02`, and `TS-R1-03`.
3. Implement the nonterminal provider-native state model in `TS-R4-00`.
4. Obtain explicit human approval for read-only ProjectX subscription/credential use.
5. Capture sanitized provider payloads and stream/reconnect truth for `TS-R2-*`.
6. Do not authorize order mutation until the read-only shadow gate passes.

## Authority model

### ProjectX

Owns authoritative venue/account truth:

- accounts and stages as actually exposed;
- contracts and provider identifiers;
- current positions;
- open and historical orders;
- trades/fills;
- quote, print, depth, and history streams;
- provider acceptance, rejection, and session behavior.

### Glitch Topstep

Owns:

- normalized local snapshot;
- redacted durable evidence;
- exact configured account/contract scope;
- local intent identity and outbox;
- risk calculations from supplied evidence;
- factual execution validation;
- provider mutation request;
- reconciliation and recovery;
- local authenticated API.

### Hermes Topstep operator

Owns probabilistic decision selection within the published packet. It never receives ProjectX credentials and must not infer provider truth absent from the packet.

### Human operator/tester

Owns:

- API subscription and credentials;
- selected account and contract;
- policy facts not provider-reconciled;
- shadow/armed mode;
- any real mutation approval;
- external publication and readiness claims.

## SWOT

### Strengths

- Direct ProjectX implementation avoids NinjaTrader/AddOn/event-subscription complexity.
- SQLite execution store separates durable identity from append-only human evidence.
- Body-hash ownership and unique intent ID are first-class.
- `BEGIN IMMEDIATE` transaction serializes claims and outbox transitions.
- Entry-submission latch survives process restart.
- New exposure is blocked while one entry is pending or provider outcome is ambiguous.
- Recovery distinguishes `prepared` from `submitting` and ambiguous states.
- Provider historical search uses unique custom tag plus account, contract, side, size, and order type.
- REST client has strict envelopes, timeouts, rate-limit backoff, and entity parsing.
- Shadow is the default, with a deliberately alarming armed acknowledgement.
- Provider credentials remain in the gateway process rather than Hermes.
- Local API uses timing-safe bearer comparison and a raw-byte body limit.
- Market evidence has bounded retention separate from execution authority.
- Reconnect invalidates packets and triggers reconciliation before new packet use.
- Package has one simple `npm run check` gate.

### Weaknesses

- Startup does extensive provider login, scope fetch, history, market observation, order-flow refresh, recovery, and real-time startup before binding the local gateway.
- `start.ps1` reports background startup immediately and previously killed any process owning the selected port.
- `GLITCH_LOCAL_HOST` previously accepted arbitrary interfaces despite a loopback-only safety claim.
- The service cannot run as a useful provider-disconnected health/recovery shell because config and startup require credentials and login before local API bind.
- REST `placeOrder` success becomes a `submitted` receipt before current provider position and bracket children are proven.
- Protective-child identity is not yet first-class.
- `MOVE_STOP` and `MOVE_TP` remain intentionally unimplemented.
- Real ProjectX payloads, event names, reconnect behavior, custom-tag retention, and bracket structures are unverified.
- Startup may take long enough that process supervision cannot distinguish healthy initialization from a hung process without reading logs.
- Local gateway returns raw internal error messages in authenticated responses.
- No owned PID/start-time/command-line lifecycle contract exists for background stop/restart.
- Windows reboot persistence has not been tested through actual task/service startup.

### Opportunities

- A clean direct gateway can become the simpler unified Glitch architecture if provider ownership and recovery are proved.
- Durable provider evidence can support replayable incident analysis and outcome-backed learning.
- One provider-native protected-entry contract can remove many NinjaTrader-specific races.
- A read-only shadow install can be tested by external collaborators before mutation authority exists.
- Exact process-kill tests can become a reusable execution-systems harness.
- The simple codebase can establish a strong compatibility and installation contract early.
- Topstep-specific account policy can remain evidence rather than become a generic strategy firewall.

### Threats

- An ambiguous submit followed by retry can create duplicate exposure.
- A REST order ID can be mistaken for a filled protected position.
- Provider bracket children can be absent, rejected, delayed, duplicated, or represented differently than expected.
- Current open position may include human/external activity in the same contract.
- A stale reconnect generation can publish a packet or overwrite current state.
- Local gateway exposure beyond loopback could make bearer-protected mutation reachable from LAN.
- A startup script can terminate an unrelated service or claim success while the gateway failed.
- Database corruption, permission failure, disk full, or backup software can block authority state.
- Policy values can be stale relative to account stage or payout state.
- Provider API/stream contracts can change after fixtures are captured.
- A trusted tester can unintentionally run `armed` against the wrong account/contract.

# P0 findings

## TS-STAB-01 — startup may terminate an unrelated process

Issue: https://github.com/GlitchTrader/glitch-topstep/issues/19  
Immediate PR: https://github.com/GlitchTrader/glitch-topstep/pull/20

### Source finding

The original `start.ps1` enumerated every process listening on `GLITCH_LOCAL_PORT` and called `Stop-Process -Force` without proving ownership.

The immediate PR removes this ambient termination authority and fails closed on collision. The issue remains open until the installation has an owned stop/restart identity and post-launch verification.

### Full lifecycle contract

An owned process record should bind:

- installation root or stable install ID;
- PID;
- process start time;
- executable path;
- exact command line;
- host/port;
- source/package version;
- record creation time.

Stop/restart may terminate only when the current process matches every material identity. PID alone is insufficient because Windows reuses PIDs.

### Edge cases

- unrelated process on port;
- another Glitch Topstep installation on the same port;
- stale PID record after reboot;
- PID reused by another process;
- Node child exits before provider login;
- process starts but never binds;
- process binds IPv6 while script probes IPv4;
- two listeners under different address families;
- antivirus delays process creation;
- startup run twice concurrently;
- path contains spaces/non-ASCII;
- logs cannot be created;
- `npm install`/build fails after port preflight;
- hidden process requires operator shutdown during an incident.

### Stop line

No force-kill without exact installation ownership.

## TS-STAB-02 — configurable non-loopback bind

Issue: https://github.com/GlitchTrader/glitch-topstep/issues/21  
Immediate PR: https://github.com/GlitchTrader/glitch-topstep/pull/22

### Source finding

The README said loopback-only, but `loadConfig()` accepted any `GLITCH_LOCAL_HOST` and the local server listened on it.

The immediate PR restricts production startup to numeric `127.0.0.1` or `::1` and adds deterministic tests.

### Edge cases

- wildcard IPv4/IPv6;
- LAN/private address;
- public address;
- `localhost` remapped in hosts/DNS;
- IPv4-mapped IPv6;
- bracketed IPv6 string;
- alternate code path constructing `LocalGatewayServer` directly;
- proxy or port-forward exposing loopback outside the machine;
- Windows firewall rule granting external access;
- WSL/container networking changing the trust boundary.

The product contract remains personal Windows machine, direct loopback—not remote gateway service.

## TS-R1-01/02/03 — process-kill, Windows restart, bounded recovery

Issue: https://github.com/GlitchTrader/glitch-topstep/issues/16

### Required kill points

Use a real child process and deterministic hooks:

1. after intent registration, before outbox;
2. after `prepared`, before provider call;
3. after `submitting`, before transport;
4. during transport stall;
5. after fake/provider acceptance, before durable submitted state;
6. after submitted state, before receipt;
7. after receipt, before JSONL mirror;
8. during close-position mutation;
9. during recovery reconciliation;
10. while duplicates wait.

### Required outcomes

- `prepared` can be proven not submitted;
- `submitting`/ambiguous requires provider reconciliation;
- unique complete order identity may prove entry submission;
- missing, duplicate, or mismatched evidence remains ambiguous;
- new exposure remains blocked;
- no automatic resubmission from time elapsed;
- terminal state without receipt reconstructs a receipt;
- JSONL failure does not erase committed SQLite authority;
- bounded flatten touches only exactly owned account/contract exposure.

### Windows restart edge cases

- reboot after `prepared`;
- reboot during provider call;
- Windows Update forced restart;
- resume after sleep/hibernate;
- startup task runs before network/DNS;
- data volume unavailable or read-only;
- SQLite WAL/shm files present after abrupt termination;
- DB locked by antivirus/backup/indexer;
- clock jumps backwards/forwards;
- service starts twice;
- `.env` changed between mutation and recovery;
- account/contract config changed while unresolved state exists;
- application updated before recovery completes;
- corrupted database or migration partially applied.

### Database ownership rule

If the execution database cannot be opened or verified, startup must not create a fresh empty authority database at the same logical installation and continue. It must stop with an explicit recovery/restore decision.

### Stop line

No real provider mutation until deterministic kill fixtures and read-only provider reconciliation pass.

## TS-R4-00 — nonterminal until provider-native proof

Issue: https://github.com/GlitchTrader/glitch-topstep/issues/17

### Current source behavior

`placeOrder()` returning an integer order ID becomes a `submitted` receipt. This is strong submission evidence but not proof of:

- provider acceptance after subsequent processing;
- fill/partial/cancel state;
- current position;
- native stop/target children;
- protective quantity and geometry;
- absence of duplicate tag/order.

### Required durable states

Use explicit states equivalent to:

- received;
- validated;
- prepared;
- submitting;
- submitted pending reconciliation;
- open protected;
- closed flat;
- rejected;
- confirmed not submitted;
- ambiguous;
- superseded;
- recovery required.

### Entry terminal proof

- exact account ID and name;
- exact contract ID;
- unique intent/custom tag/provider order identity;
- authoritative order lifecycle;
- attributable position/fill;
- explicit stop and target child identities;
- exact protective quantity/geometry;
- current provider generation;
- no conflicting external same-contract ownership.

### EXIT terminal proof

- exact configured attributable contract is flat;
- owned working orders are cancelled or reconciled;
- external/human activity is not commandeered;
- outcome survives restart and duplicate delivery.

### Amendment boundary

Do not implement `MOVE_STOP`/`MOVE_TP` until protective leg identity is durable and provider-native. A modify REST response remains pending until provider state confirms the selected child and unchanged siblings.

### Edge cases

- REST success, later reject;
- partial fill and cancelled remainder;
- entry fill before brackets exist;
- one child accepted and one rejected;
- bracket child IDs omitted in initial response;
- duplicate custom tag;
- provider recreates/replaces child orders;
- user manually changes/cancels bracket;
- same contract has external position;
- order fills during reconnect;
- close returns success while position remains open;
- provider positions update before historical order search;
- account has multiple entries in same contract;
- size/price rounding differs from request;
- stale packet after position change.

### Stop line

REST success alone cannot be a terminal successful execution outcome.

## TS-R2-* — real ProjectX shadow proof

Issue: https://github.com/GlitchTrader/glitch-topstep/issues/18

### Human prerequisites

- active ProjectX API subscription;
- operator-approved credentials and secret path;
- exact Topstep account and stage;
- market-data entitlement;
- explicit read-only session approval;
- separate approval for any mutation.

### Read-only acceptance

Capture and sanitize:

- login and validate;
- account search;
- available contracts;
- open positions;
- open orders;
- historical orders/trades;
- bars/history;
- user-hub events;
- market quote/print/depth events;
- disconnect/reconnect behavior;
- token refresh/expiry/rate-limit behavior.

Reconcile gateway state to TopstepX UI before any mutation.

### Sanitization requirements

- key-name redaction;
- secret-pattern scanning;
- JWT/API key/username/account ID policy;
- no raw credentials in fixtures, logs, screenshots, issue comments, or PR artifacts;
- deterministic fixture version and observation date;
- note which fields are provider-stable versus merely observed.

### Provider unknowns

- custom tag retention in open/history/trades;
- parent/child bracket identifiers;
- partial-fill event ordering;
- child-rejection behavior;
- stream method/event names;
- reconnect generations;
- whether order/trade history is eventually consistent;
- account-stage and loss-floor fields exposed by provider;
- rate limits and retry headers;
- market event volume and depth semantics;
- corrections/voids to historical trades.

### Stop line

Read-only until a separate bounded mutation approval states account, contract, quantity, side, protection, exposure, recovery, observer, and stop conditions.

# P1 findings

## Gateway availability during provider failure

The local gateway binds only after ProjectX login, startup scope fetch, history sync, market observation, order-flow refresh, recovery, real-time start, and reconciliation.

This has benefits—no false healthy local server before provider state exists—but weakens observability and recovery when credentials/network/provider are unavailable.

Decide explicitly between:

1. current fail-closed process model; or
2. an early local health/control shell that reports `initializing`, `provider_unavailable`, or `recovery_required` but refuses packets/intents.

Do not accidentally bind an execution-capable API before durable recovery.

Questions:

- How does the tester know why hidden background startup failed?
- Can the operator inspect unresolved SQLite state without valid current ProjectX credentials?
- What timeout separates slow provider initialization from hung startup?
- Should startup supervise retries or exit and let Windows task/service policy restart?

## Internal error disclosure

`LocalGatewayServer` returns `error.message` for internal exceptions. Even on loopback with a bearer token, model/operator clients should receive stable public error codes rather than filesystem, SQLite, provider, or parser internals.

Required direction:

- log structured internal error locally with redaction;
- return generic `internal_error` plus a request/event ID;
- keep safe validation messages for known bounded client errors;
- test that credentials, paths, provider bodies, and stored payloads do not enter API responses.

## Background process truth

`start.ps1` currently starts a hidden process and prints a success URL immediately. Because service bind occurs after potentially long provider initialization, this is launch confirmation, not health confirmation.

Full startup tooling should:

- report PID and log paths;
- optionally wait for `/health` under a bounded timeout;
- distinguish process launched, gateway initializing, gateway healthy/degraded, and process exited;
- never infer readiness from `Start-Process` alone;
- support a separate read-only status command.

## Policy freshness

Operator-configured loss model, stage, EOD balance, payout, and floor facts can become stale.

Each decision packet/health state should name:

- authority source;
- verification timestamp;
- expected refresh cadence;
- fields still operator asserted;
- fields reconciled from provider;
- stale/unknown status;
- resulting gateway mode downgrade.

No stale policy should silently remain executable.

## Local token lifecycle

Define:

- generation quality and storage ACL;
- rotation while Hermes profile runs;
- revocation and profile mismatch;
- accidental token logging;
- multiple profiles/installations;
- token equality across test/prod installs;
- backup/restore behavior;
- process environment inspection by local users.

The bearer protects a loopback boundary but is not a substitute for OS account isolation.

## Evidence retention and disk failure

Market evidence retention is bounded, but test:

- event bursts beyond pruning cadence;
- DB size under full session;
- disk full during evidence versus execution commit;
- corruption recovery;
- backup/restore of both databases at a consistent point;
- execution DB FULL sync versus provider-evidence NORMAL sync;
- pruning never touching execution/account/order/trade evidence required for ownership.

## JSONL mirror semantics

SQLite is authoritative for execution. JSONL is a human/evidence mirror. Health and incident tooling should expose when JSONL append fails rather than only logging to stderr.

## Time and generation semantics

All staleness and leases need tests for:

- clock skew;
- system sleep;
- DST/local time independence;
- provider timestamps in unexpected zones;
- out-of-order events;
- reconnect generation rollover;
- events from old connection arriving after new reconciliation;
- packet lease spanning restart.

# P2 findings

- Broader order-flow/market features follow provider contract proof and measured usefulness.
- UI can remain minimal until local health/recovery/install semantics are stable.
- Additional instruments/accounts are out of scope until one exact account/contract path is accepted.
- Refactor only where it strengthens state ownership, provider parsing, or test injection.
- Do not import NinjaTrader/Apex replication code; parity is behavioral only.

# P3 / deferred

- live/evaluation automatic operation;
- multi-account fan-out;
- generalized broker abstraction;
- hosted/VPS deployment;
- remote API access;
- automatic payout/account-stage changes;
- strategy expansion before provider-native lifecycle proof.

# White-hat threat model

## Assets

- ProjectX credentials and session token;
- selected account/contract authority;
- local bearer token;
- execution database and latch;
- provider evidence database;
- intent/receipt history;
- policy and risk facts;
- hidden process lifecycle;
- companion profile packet/intent path.

## Attack surfaces

- `.env` parsing and filesystem permissions;
- local gateway bind and endpoints;
- bearer token handling;
- request body/parser/error paths;
- provider REST and SignalR payloads;
- SQLite/JSONL paths;
- PowerShell start/stop/update scripts;
- companion Hermes profile;
- logs and sanitized fixtures;
- configuration changes between restart/recovery.

## Abuse/failure cases

- LAN exposure through host misconfiguration;
- arbitrary local port-owner termination;
- local malware reads token and submits intent;
- same token reused across installations;
- provider error contains credential/request data and is returned to client;
- crafted payload causes oversized/slow request;
- invalid JSON becomes raw internal error;
- `.env` path or data directory points outside intended install;
- symlink/junction redirects databases/logs;
- API URL changed to untrusted endpoint that receives credentials;
- provider fixture accidentally contains secrets;
- config changes selected account while unresolved intent exists;
- hidden process starts from stale compiled output;
- `npm install` executes dependency scripts during ordinary start.

# Blue-team controls

- numeric loopback-only bind;
- fail-closed port collision and installation-owned process lifecycle;
- stable public API errors with request IDs;
- local token ACL/rotation and per-install identity;
- allowed-provider URL/host policy or explicit high-risk override;
- config fingerprint bound to execution database/recovery state;
- durable expected transitions and process-kill hooks;
- provider-native protected terminal state;
- generation-aware event/reconciliation barriers;
- redacted structured logs and fixture scanner;
- exact Windows startup/status/stop contract;
- backup/restore and corrupt-database drills;
- shadow default with separate mutation approval.

# Wargames

## Wargame 1 — ambiguous submit and reboot

Kill the process after provider accepts but before durable submitted state, then reboot. Success: one unique provider order is reconciled or state remains ambiguous; no second order is sent; new exposure remains blocked.

## Wargame 2 — bracket child failure

Provider entry fills but one or both protective children are absent/rejected/delayed. Success: intent never becomes `open_protected`; recovery/critical state is explicit; no learning success is emitted.

## Wargame 3 — stale reconnect generation

Disconnect user/market streams, update positions/orders during outage, reconnect with delayed old events. Success: packets remain invalid until REST reconciliation; old-generation events cannot overwrite new state.

## Wargame 4 — local attacker/misconfiguration

Set wildcard/LAN bind, occupy port with unrelated service, send oversized/invalid/auth-failed requests. Success: invalid bind fails, unrelated process survives, request limits/auth hold, no secret/internal path leaks.

## Wargame 5 — database incident

Inject disk full, read-only directory, WAL corruption, DB lock, and missing DB during unresolved intent. Success: no fresh empty authority is silently created; no provider mutation occurs; recovery/restore action is explicit.

## Wargame 6 — policy drift

Change account stage, EOD balance, payout/floor, account/contract env, or max contracts while unresolved state exists. Success: execution blocks until config fingerprint and provider truth are reconciled; old packet cannot execute.

## Wargame 7 — human interleave

A human or external system opens/closes/modifies the same contract during a pending Glitch intent. Success: Glitch uses exact provider IDs/tags and does not claim price/time-proximate activity; ambiguity remains bounded.

## Wargame 8 — duplicate storm

Send 100 identical intents, conflicts with same UUID, and different valid UUIDs concurrently while the provider call is delayed. Success: one mutation for the owned intent, conflicts rejected, new exposure latch enforced, receipts immutable.

# Ledger consolidation

The next ledger reconciliation should:

1. add `TS-STAB-01` and `TS-STAB-02` P0 with their immediate PRs and remaining acceptance;
2. keep `TS-R1-01`, `TS-R1-02`, and `TS-R1-03` separate, all dependency-ordered;
3. keep `TS-R4-00` P0 ready/in-progress before amendments;
4. keep `TS-R4-01` blocked/backlog until real provider bracket identity is observed;
5. preserve `TS-R1-05` as done with body-hash/concurrency evidence, without implying provider-native terminal proof;
6. keep `TS-R2-*` blocked on human subscription/credential and provider evidence;
7. reduce broad P1/P2 work until process/restart/native-provider foundations close;
8. attach exact source, test, Windows, provider, and reviewer evidence per row;
9. never close provider proof from mocks alone or close durable architecture from a real happy-path session alone.

GitHub issues coordinate implementation; the ledger owns status and evidence.

# Recommended execution order

1. Review/merge TS-STAB-01 immediate fail-closed port fix.
2. Review/merge TS-STAB-02 loopback-only bind fix.
3. Add deterministic process-kill hooks and run fake-provider matrix.
4. Run real Windows restart/persistence fixtures.
5. Implement `TS-R4-00` pending/native-terminal state model against deterministic fixtures.
6. Obtain operator-approved ProjectX read-only access.
7. Capture sanitized payload/stream/reconnect fixtures and reconcile TopstepX UI.
8. Implement `TS-R4-01` exact bracket ownership from observed IDs.
9. Request one separately bounded mutation fixture, if warranted.
10. Lock one Windows install/profile/source baseline with rollback and incident procedures.

# Questions for the operator/tester

1. Does the selected Topstep account already have ProjectX API subscription and market-data entitlement?
2. Which account stage and loss model are being tested?
3. Which exact account and contract may be used read-only, and which may ever receive a bounded mutation?
4. Is the intended supported install a foreground process, hidden script, Startup task, Scheduled Task, or Windows service?
5. Should startup expose an early read-only health shell when ProjectX is unavailable, or exit completely?
6. Which data and credentials must survive machine reboot, repository update, and profile reinstall?
7. Who independently observes the first provider mutation fixture?
8. What is the maximum acceptable session evidence disk footprint?
9. What exact TopstepX UI facts should be captured for reconciliation without leaking personal/account information?
10. Is Topstep intended to supersede Advanced eventually, or remain a separate simpler product until evidence decides?

# Stop line

No provider mutation, evaluation/live readiness claim, remote exposure, or automatic retry from ambiguity until the relevant P0 process, native-state, and human-gated provider contracts pass.