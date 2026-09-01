---
name: topstep-build-intent
description: Convert one Glitch Topstep decision into the exact strict `glitch.intent.v3` object accepted by the local gateway.
---

# Build Intent

Return exactly one JSON object and no Markdown or prose.

- Preserve the supplied account alias, instrument, operator profile `glitch-topstep`, and snapshot hash exactly.
- Required core fields: `schema_version`, UUID `intent_id`, `created_utc`, `instrument`, `account`, `operator_profile`, `action`, `confidence`, `snapshot_hash`, `model_version`, `prompt_version`, `reason`, and `decision_audit`.
- Replace template placeholders (`<CHOOSE_FROM_supported_actions>`, `<0.0-1.0>`, `Replace`) with real values; never emit placeholder strings.
- `decision_audit` contains exactly: `bull_case`, `bear_case`, `flat_case`, `aggressive_case`, `conservative_case`, `decisive_evidence`, `disconfirming_evidence`, `change_condition`, and `final_choice`. `final_choice` equals `action`.
- `decisive_evidence` must begin with `prior_hypothesis=<CONFIRMED|INVALIDATED|PARTIALLY_CONFIRMED|UNCHANGED>` when `recent_frames` is non-empty, then state material deltas since the immediately prior frame.
- Choose `action` only from `execution.supported_actions` in the current packet. Rebuild the action from current evidence; do not copy a prior cycle default. Never `HOLD` while flat; never `NOTHING` while positioned.
- For `ENTER_LONG` and `ENTER_SHORT`, use a positive integer `quantity` within `policy.max_contracts` and `execution.maximum_additional_contracts`, `order_type: "MARKET"`, and absolute numeric `stop_loss` and `take_profit_1`. Omit `wake_triggers`.
- For `HOLD` and `NOTHING`, omit `quantity`, `order_type`, `stop_loss`, `take_profit_1`, amendment fields, and exit sizing fields. `wake_triggers` is optional local-only scheduling metadata; omit it unless you want an early wake before the next flat cadence.
- For `MOVE_STOP`, include absolute numeric `new_stop_price`. Omit entry fields and `wake_triggers`. Include `target_intent_id` when more than one tranche in `protection.tranches` still holds contracts. Submit only when `protection.protection_status` is `confirmed`.
- For `MOVE_TP`, include absolute numeric `new_take_profit` or `take_profit_1`. Omit entry fields and `wake_triggers`. Include `target_intent_id` when more than one active tranche remains. Submit only when `protection.protection_status` is `confirmed`.
- For `EXIT`, omit entry, amendment, and `wake_triggers` fields. For a full EXIT that closes the entire active position, omit both `quantity` and `exit_fraction`. Request a partial EXIT only when the packet explicitly advertises proven partial-reduction continuity; otherwise use full EXIT or HOLD. Include `target_intent_id` when reducing a specific tranche in a multi-tranche book.
- `change_condition` is advisory text for later accountability; price levels in it do not require mirrored `wake_triggers`.
- Do not emit limit orders, provider IDs, credentials, additional fields, multiple objects, comments, or trailing text.

Glitch performs final identity, freshness, geometry, risk, and execution validation.
