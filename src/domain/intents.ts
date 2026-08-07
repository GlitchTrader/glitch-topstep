import { TradeActions, type DecisionAudit, type TradeAction, type TradeIntent } from "./models.js";
import {
  GLITCH_TOPSTEP_OPERATOR_PROFILE,
  GLITCH_TOPSTEP_PROMPT_VERSION,
} from "./operator.js";

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
  "new_stop_price",
  "new_take_profit",
  "exit_fraction",
  "target_intent_id",
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

export class IntentParseError extends Error {
  public readonly errorCode: string;
  public readonly field?: string;
  public readonly path?: string;

  public constructor(errorCode: string, field?: string, path?: string) {
    super(errorCode);
    this.name = "IntentParseError";
    this.errorCode = errorCode;
    this.field = field;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string, maxLength = 1000): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0 || field.length > maxLength) {
    throw new IntentParseError("invalid_string_field", key);
  }
  return field;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new IntentParseError("invalid_number_field", key);
  }
  return field;
}

function parseAction(value: unknown): TradeAction {
  if (typeof value !== "string" || !TradeActions.includes(value as TradeAction)) {
    throw new IntentParseError("invalid_action", "action");
  }
  return value as TradeAction;
}

function parseDecisionAudit(value: unknown, action: TradeAction): DecisionAudit {
  if (!isRecord(value)) {
    throw new IntentParseError("decision_audit_invalid", "decision_audit");
  }
  for (const key of Object.keys(value)) {
    if (!AUDIT_FIELDS.has(key)) {
      throw new IntentParseError("decision_audit_unknown_field", `decision_audit.${key}`, `decision_audit.${key}`);
    }
  }
  if (Object.keys(value).length !== AUDIT_FIELDS.size) {
    throw new IntentParseError("decision_audit_incomplete", "decision_audit");
  }
  const finalChoice = parseAction(value.final_choice);
  if (finalChoice !== action) {
    throw new IntentParseError("final_choice_must_equal_action", "decision_audit.final_choice", "decision_audit.final_choice");
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
    throw new IntentParseError("intent_must_be_object");
  }
  for (const key of Object.keys(input)) {
    if (!CORE_FIELDS.has(key)) {
      throw new IntentParseError("unknown_intent_field", key);
    }
  }
  if (input.schema_version !== "glitch.intent.v2") {
    throw new IntentParseError("schema_version_invalid", "schema_version");
  }

  const intentId = stringField(input, "intent_id", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
    throw new IntentParseError("intent_id_must_be_uuid", "intent_id");
  }
  const createdUtc = stringField(input, "created_utc", 64);
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(createdUtc) || !Number.isFinite(Date.parse(createdUtc))) {
    throw new IntentParseError("created_utc_invalid", "created_utc");
  }
  const operatorProfile = stringField(input, "operator_profile", 128);
  if (operatorProfile !== GLITCH_TOPSTEP_OPERATOR_PROFILE) {
    throw new IntentParseError("operator_profile_mismatch", "operator_profile");
  }
  const promptVersion = stringField(input, "prompt_version", 128);
  if (promptVersion !== GLITCH_TOPSTEP_PROMPT_VERSION) {
    throw new IntentParseError("prompt_version_mismatch", "prompt_version");
  }
  const action = parseAction(input.action);
  const confidence = input.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new IntentParseError("confidence_invalid", "confidence");
  }

  const quantity = optionalNumber(input, "quantity");
  const stopLoss = optionalNumber(input, "stop_loss");
  const takeProfit1 = optionalNumber(input, "take_profit_1");
  const newStopPrice = optionalNumber(input, "new_stop_price");
  const newTakeProfit = optionalNumber(input, "new_take_profit");
  const exitFraction = optionalNumber(input, "exit_fraction");
  const targetIntentIdRaw = input.target_intent_id;
  const orderType = input.order_type;
  if (orderType !== undefined && orderType !== "MARKET") {
    throw new IntentParseError("order_type_invalid", "order_type");
  }

  let targetIntentId: string | undefined;
  if (targetIntentIdRaw !== undefined) {
    if (action !== "EXIT" && action !== "MOVE_STOP" && action !== "MOVE_TP") {
      throw new IntentParseError("target_intent_id_only_allowed_on_exit_or_amendment", "target_intent_id");
    }
    if (typeof targetIntentIdRaw !== "string") {
      throw new IntentParseError("target_intent_id_invalid", "target_intent_id");
    }
    targetIntentId = stringField({ target_intent_id: targetIntentIdRaw }, "target_intent_id", 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetIntentId)) {
      throw new IntentParseError("target_intent_id_must_be_uuid", "target_intent_id");
    }
  }

  const entry = action === "ENTER_LONG" || action === "ENTER_SHORT";
  if (entry) {
    if (!Number.isInteger(quantity) || (quantity ?? 0) < 1 || orderType !== "MARKET") {
      throw new IntentParseError("entry_fields_invalid", "quantity");
    }
    if (stopLoss === undefined || stopLoss <= 0 || takeProfit1 === undefined || takeProfit1 <= 0) {
      throw new IntentParseError("entry_fields_invalid", "stop_loss");
    }
  } else if (action === "MOVE_STOP") {
    if (newStopPrice === undefined || newStopPrice <= 0) {
      throw new IntentParseError("move_stop_requires_new_stop_price", "new_stop_price");
    }
    if (
      quantity !== undefined
      || orderType !== undefined
      || stopLoss !== undefined
      || takeProfit1 !== undefined
      || newTakeProfit !== undefined
      || exitFraction !== undefined
    ) {
      throw new IntentParseError("move_stop_extra_fields");
    }
  } else if (action === "MOVE_TP") {
    const targetPrice = newTakeProfit ?? takeProfit1;
    if (targetPrice === undefined || targetPrice <= 0) {
      throw new IntentParseError("move_tp_requires_target_price", "new_take_profit");
    }
    if (
      quantity !== undefined
      || orderType !== undefined
      || stopLoss !== undefined
      || newStopPrice !== undefined
      || exitFraction !== undefined
    ) {
      throw new IntentParseError("move_tp_extra_fields");
    }
  } else if (action === "EXIT") {
    if (orderType !== undefined || stopLoss !== undefined || takeProfit1 !== undefined) {
      throw new IntentParseError("exit_entry_fields_forbidden");
    }
    if (newStopPrice !== undefined || newTakeProfit !== undefined) {
      throw new IntentParseError("exit_amendment_fields_forbidden");
    }
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
      throw new IntentParseError("exit_quantity_invalid", "quantity");
    }
    if (exitFraction !== undefined && (exitFraction <= 0 || exitFraction > 1)) {
      throw new IntentParseError("exit_fraction_invalid", "exit_fraction");
    }
    if (quantity !== undefined && exitFraction !== undefined) {
      throw new IntentParseError("exit_quantity_and_fraction_conflict");
    }
  } else if (
    quantity !== undefined
    || orderType !== undefined
    || stopLoss !== undefined
    || takeProfit1 !== undefined
    || newStopPrice !== undefined
    || newTakeProfit !== undefined
    || exitFraction !== undefined
  ) {
    throw new IntentParseError("non_entry_fields_forbidden");
  }

  const resolvedTakeProfit = action === "MOVE_TP"
    ? (newTakeProfit ?? takeProfit1)
    : takeProfit1;

  return {
    schemaVersion: "glitch.intent.v2",
    intentId,
    createdUtc,
    instrument: stringField(input, "instrument", 32),
    account: stringField(input, "account", 128),
    operatorProfile,
    action,
    confidence,
    snapshotHash: stringField(input, "snapshot_hash", 256),
    modelVersion: stringField(input, "model_version", 128),
    promptVersion,
    reason: stringField(input, "reason", 1000),
    decisionAudit: parseDecisionAudit(input.decision_audit, action),
    ...(quantity === undefined ? {} : { quantity }),
    ...(orderType === undefined ? {} : { orderType }),
    ...(stopLoss === undefined ? {} : { stopLoss }),
    ...(resolvedTakeProfit === undefined ? {} : { takeProfit1: resolvedTakeProfit }),
    ...(newStopPrice === undefined ? {} : { newStopPrice }),
    ...(newTakeProfit === undefined ? {} : { newTakeProfit }),
    ...(exitFraction === undefined ? {} : { exitFraction }),
    ...(targetIntentId === undefined ? {} : { targetIntentId }),
  };
}
