import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "gateway", "execution_facts_live_sample.json");

test("TS-EXEC-01 live sample fixture matches execution_facts.v1 contract", () => {
  const sample = JSON.parse(fs.readFileSync(FIXTURE, "utf8").replace(/^\uFEFF/, "")) as {
    health_execution_facts: { live: number; superseded: number };
    health_provider_evidence_queue: { dropped: { identity: number }; degraded: boolean };
    facts_page: {
      schema_version: string;
      facts: Array<{
        fact_id: string;
        phase: string;
        status: string;
        revision: number;
        diagnostics: Record<string, unknown>;
      }>;
    };
  };

  assert.equal(sample.facts_page.schema_version, "glitch.topstep.execution_facts.v1");
  assert.ok(sample.health_execution_facts.live >= 1);
  assert.equal(sample.health_provider_evidence_queue.dropped.identity, 0);
  assert.equal(sample.health_provider_evidence_queue.degraded, false);

  for (const fact of sample.facts_page.facts) {
    assert.match(fact.fact_id, /^fact:[^:]+:[a-z_]+$/);
    assert.equal(fact.status, "live");
    assert.equal(fact.revision, 1);
    assert.ok(typeof fact.diagnostics === "object");
  }

  const phases = sample.facts_page.facts.map((fact) => fact.phase);
  assert.ok(phases.includes("intent_admitted"));
  assert.ok(phases.some((phase) => phase.endsWith("_rejected") || phase.includes("rejected")));
});
