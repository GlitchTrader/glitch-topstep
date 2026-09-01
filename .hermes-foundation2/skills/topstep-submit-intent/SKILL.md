---
name: topstep-submit-intent
description: Explain the supported interactive path for steering the Topstep decision worker without bypassing it.
---

# Submit Topstep Intent

Interactive Hermes chat never writes an outbox decision or posts a raw intent to the gateway.

1. Use `/bias_long`, `/bias_short`, or `/bias_neutral` for a one-cycle soft advisory.
2. Use `/long` or `/short` only for an operator-directed experiment on the configured Topstep account when flat and entry-eligible. The command writes a bounded directive; the next stateless worker cycle still calculates structure and emits the decision.
3. Use `/flatten_all` to pause cognition and submit one deterministic `EXIT` when positioned.
4. The installed worker alone validates the intent, writes the outbox, and delivers through the authenticated local gateway.
5. Gateway receipts and execution events are authoritative. A chat response is never evidence that an order exists.

Never write or replace an outbox file, invoke the worker manually to force a second decision, mutate gateway policy, or place an order outside the worker and gateway path.
