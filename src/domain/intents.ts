import { TradeActions, type DecisionAudit, type TradeAction, type TradeIntent } from "./models.js";

const CORE_FIELDS = new Set([
  "schema_version",
  "intent_id",
  "created_utc",
  "instrument",
  "account",
  "operator_profile",
  "action",
  "confidence",
  "snapshot_hash",
  "model_version",
  "prompt_version",
  "reason",
  "decision_audit",
  "quantity",
  "order_type",
  "stop_loss",
  "take_profit_1",
]);

const AUDIT_FIELDS = new Set([
  "bull_case",
  "bear_case",
  "flat_case",
  "aggressive_case",
  "conservative_case",
  "decisive_evidence",
  "disconfirming_evidence",
  "change_condition",
  "final_choice",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string, maxLength = 1000): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0 || field.length > maxLength) {
    throw new Error(`invalid_string_field:${key}`);
  }
  return field;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`invalid_number_field:${key}`);
  }
  return field;
}

function parseAction(value: unknown): TradeAction {
  if (typeof value !== "string" || !TradeActions.includes(value as TradeAction)) {
    throw new Error("invalid_action");
  }
  return value as TradeAction;
}

function parseDecisionAudit(value: unknown, action: TradeAction): DecisionAudit {
  if (!isRecord(value)) {
    throw new Error("decision_audit_invalid");
  }
  for (const key of Object.keys(value)) {
    if (!AUDIT_FIELDS.has(key)) {
      throw new Error(`decision_audit_unknown_field:${key}`);
    }
  }
  if (Object.keys(value).length !== AUDIT_FIELDS.size) {
    throw new Error("decision_audit_incomplete");
  }
  const finalChoice = parseAction(value.final_choice);
  if (finalChoice !== action) {
    throw new Error("final_choice must equal action");
  }
  return {
    bullCase: stringField(value, "bull_case", 500),
    bearCase: stringField(value, "bear_case", 500),
    flatCase: stringField(value, "flat_case", 500),
    aggressiveCase: stringField(value, "aggressive_case", 500),
    conservativeCase: stringField(value, "conservative_case", 500),
    decisiveEvidence: stringField(value, "decisive_evidence", 500),
    disconfirmingEvidence: stringField(value, "disconfirming_evidence", 500),
    changeCondition: stringField(value, "change_condition", 500),
    finalChoice,
  };
}

export function parseTradeIntent(input: unknown): TradeIntent {
  if (!isRecord(input)) {
    throw new Error("intent_must_be_object");
  }
  for (const key of Object.keys(input)) {
    if (!CORE_FIELDS.has(key)) {
      throw new Error(`unknown_intent_field:${key}`);
    }
  }
  if (input.schema_version !== "glitch.intent.v2") {
    throw new Error("schema_version_invalid");
  }

  const intentId = stringField(input, "intent_id", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
    throw new Error("intent_id_must_be_uuid");
  }
  const createdUtc = stringField(input, "created_utc", 64);
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(createdUtc) || !Number.isFinite(Date.parse(createdUtc))) {
    throw new Error("created_utc_invalid");
  }
  const action = parseAction(input.action);
  const confidence = input.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence_invalid");
  }

  const quantity = optionalNumber(input, "quantity");
  const stopLoss = optionalNumber(input, "stop_loss");
  const takeProfit1 = optionalNumber(input, "take_profit_1");
  const orderType = input.order_type;
  if (orderType !== undefined && orderType !== "MARKET") {
    throw new Error("order_type_invalid");
  }

  const entry = action === "ENTER_LONG" || action === "ENTER_SHORT";
  if (entry) {
    if (!Number.isInteger(quantity) || (quantity ?? 0) < 1 || orderType !== "MARKET") {
      throw new Error("entries require quantity, MARKET order_type, stop_loss, and take_profit_1");
    }
    if (stopLoss === undefined || stopLoss <= 0 || takeProfit1 === undefined || takeProfit1 <= 0) {
      throw new Error("entries require quantity, MARKET order_type, stop_loss, and take_profit_1");
    }
  } else if (
    quantity !== undefined
    || orderType !== undefined
    || stopLoss !== undefined
    || takeProfit1 !== undefined
  ) {
    throw new Error("non-entry actions cannot carry entry fields in the initial direct gateway");
  }

  return {
    schemaVersion: "glitch.intent.v2",
    intentId,
    createdUtc,
    instrument: stringField(input, "instrument", 32),
    account: stringField(input, "account", 128),
    operatorProfile: stringField(input, "operator_profile", 128),
    action,
    confidence,
    snapshotHash: stringField(input, "snapshot_hash", 256),
    modelVersion: stringField(input, "model_version", 128),
    promptVersion: stringField(input, "prompt_version", 128),
    reason: stringField(input, "reason", 1000),
    decisionAudit: parseDecisionAudit(input.decision_audit, action),
    ...(quantity === undefined ? {} : { quantity }),
    ...(orderType === undefined ? {} : { orderType }),
    ...(stopLoss === undefined ? {} : { stopLoss }),
    ...(takeProfit1 === undefined ? {} : { takeProfit1 }),
  };
}
