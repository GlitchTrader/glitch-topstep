export const R1_04_KILL_PROOF_SCHEMA = "glitch.projectx.r1_04_kill_proof.v1" as const;

export interface R1_04KillCase {
  kill_point?: string;
  test?: string;
  intent_id: string;
  proof_passed: boolean;
  proof_failures: string[];
  provider_entry_orders_after_replay?: number;
  gateway_killed?: boolean;
}

export interface R1_04KillProof {
  schema_version: typeof R1_04_KILL_PROOF_SCHEMA;
  captured_utc: string;
  mode: "live_prac_acceptance";
  scope: {
    account_id: number;
    account_name: string;
    contract_id: string;
    instrument: string;
  };
  cases: R1_04KillCase[];
  proof_passed: boolean;
  proof_failures: string[];
}

export function validateR1_04KillProof(proof: R1_04KillProof): string[] {
  const failures: string[] = [];
  if (proof.schema_version !== R1_04_KILL_PROOF_SCHEMA) {
    failures.push("schema_version_invalid");
    return failures;
  }
  if (!proof.proof_passed) {
    return [...(proof.proof_failures ?? [])];
  }
  const killCases = proof.cases.filter((entry) => entry.kill_point);
  if (killCases.length < 4) {
    failures.push("kill_cases_incomplete");
  }
  for (const entry of killCases) {
    if (entry.gateway_killed === false) {
      failures.push(`gateway_not_killed:${entry.kill_point}`);
    }
    if ((entry.provider_entry_orders_after_replay ?? 0) > 1) {
      failures.push(`duplicate_entry:${entry.kill_point}`);
    }
  }
  const conflict = proof.cases.find((entry) => entry.test === "body_conflict");
  if (!conflict?.proof_passed) {
    failures.push("body_conflict_missing");
  }
  return failures;
}
