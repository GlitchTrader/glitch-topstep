---
name: topstep-self-heal
description: Reconcile Hermes-owned Topstep state to fresh authenticated gateway evidence without inventing venue truth.
---

# Topstep Self Heal

Use this truth order:

1. fresh authenticated Glitch Topstep gateway state and canonical ProjectX-derived order/trade/position evidence;
2. immutable decision packets, local outbox, delivery receipts, and canonical outcomes;
3. operator-confirmed facts;
4. Hermes supervisor state, plans, sessions, and memory;
5. inference.

Rebuild only Hermes-owned derived state. Retry delivery only with the same validated packet and intent ID while the packet remains current. Clear a lock only after proving no owning process remains. Append every correction with old claim, authoritative evidence, action, and UTC time.

If safety cannot be proven, stop new cognition for the affected capability, preserve provider-side protection, record the unresolved fault, and continue diagnosis. Never fabricate fills, protection, account state, recovery, or a bookkeeping trade.
