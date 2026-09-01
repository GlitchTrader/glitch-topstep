"""Profile ↔ gateway compatibility contract for glitch-topstep-hermes-profile."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from distribution_manifest import (
    MIN_GATEWAY_VERSION,
    PROMPT_VERSION,
    TESTED_GATEWAY_VERSION,
    read_distribution_version,
)

_PROFILE_VERSION = read_distribution_version(Path(__file__).resolve().parent.parent)

PROFILE_COMPATIBILITY: dict[str, Any] = {
    "profile_name": "glitch-topstep",
    "profile_version": _PROFILE_VERSION,
    "setup_schema": "glitch.topstep.hermes.setup.v1",
    "operator_schema": "glitch.topstep.hermes.operator.v2",
    "protocol_revision": "glitch.topstep.paired.v3",
    "intent_schema": "glitch.intent.v3",
    "decision_packet_schemas": [
        "glitch.direct.decision_packet.v1",
        "glitch.direct.decision_packet.v2",
    ],
    "prompt_version": PROMPT_VERSION,
    "health_schema": "glitch.direct.health.v2",
    "gateway_name": "glitch-topstep",
    "min_gateway_version": MIN_GATEWAY_VERSION,
    "tested_gateway_version": TESTED_GATEWAY_VERSION,
    "hermes_requires": ">=0.18.2",
    "required_capabilities": [
        "packet_supported_actions",
        "durable_mutation_receipts",
        "restart_reconciliation",
        "bounded_entry_range_v1",
        "daily_capture_context_v1",
        "explicit_partial_completed_bars_v1",
        "revisioned_outcome_feed_v1",
        "multi_instrument_observation_v1",
        "partial_exit_fail_closed_v1",
    ],
    "required_semantic_revisions": {
        "bounded_entry_range": "glitch.topstep.entry_range.v1",
        "daily_capture": "glitch.topstep.daily_capture.v1",
        "outcome_feed": "glitch.topstep.outcome_feed.v1",
        "market_universe": "glitch.topstep.market_universe.v1",
        "execution_facts": "glitch.topstep.execution_fact.v1",
    },
    "required_provider_acceptance_evidence": {
        "partial_exit_protection_transition": "not_proven_fail_closed",
        "exact_contract_resolution": "catalog_fixture_plus_runtime_resolution",
    },
    "paired_manifest_schema": "glitch.topstep.paired_release.v1",
}


def parse_version(value: str) -> tuple[int, ...]:
    parts: list[int] = []
    for segment in str(value).strip().split("."):
        if not segment.isdigit():
            raise ValueError(f"invalid version segment: {value!r}")
        parts.append(int(segment))
    if not parts:
        raise ValueError(f"invalid version: {value!r}")
    return tuple(parts)


def version_at_least(actual: str, minimum: str) -> bool:
    return parse_version(actual) >= parse_version(minimum)


def compatibility_issues(health: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if health.get("schema_version") != PROFILE_COMPATIBILITY["health_schema"]:
        issues.append(
            "health_schema_mismatch:"
            f"{health.get('schema_version')!r}!={PROFILE_COMPATIBILITY['health_schema']!r}"
        )

    contract = health.get("compatibility")
    if not isinstance(contract, dict):
        issues.append("gateway_missing_compatibility_contract")
        return issues

    if contract.get("gateway_name") != PROFILE_COMPATIBILITY["gateway_name"]:
        issues.append(
            "gateway_name_mismatch:"
            f"{contract.get('gateway_name')!r}!={PROFILE_COMPATIBILITY['gateway_name']!r}"
        )
    if contract.get("protocol_revision") != PROFILE_COMPATIBILITY["protocol_revision"]:
        issues.append(
            "protocol_revision_mismatch:"
            f"{contract.get('protocol_revision')!r}!={PROFILE_COMPATIBILITY['protocol_revision']!r}"
        )

    gateway_version = str(contract.get("gateway_version") or "").strip()
    if not gateway_version:
        issues.append("gateway_version_missing")
    elif not version_at_least(
        gateway_version,
        str(PROFILE_COMPATIBILITY["min_gateway_version"]),
    ):
        issues.append(
            "gateway_version_too_old:"
            f"{gateway_version}<{PROFILE_COMPATIBILITY['min_gateway_version']}"
        )

    intent_schemas = contract.get("intent_schemas")
    if not isinstance(intent_schemas, list):
        issues.append("intent_schemas_missing")
    elif PROFILE_COMPATIBILITY["intent_schema"] not in intent_schemas:
        issues.append(
            "intent_schema_unsupported:"
            f"{PROFILE_COMPATIBILITY['intent_schema']!r}"
        )

    packet_schemas = contract.get("decision_packet_schemas")
    required_packets = set(PROFILE_COMPATIBILITY["decision_packet_schemas"])
    if not isinstance(packet_schemas, list):
        issues.append("decision_packet_schemas_missing")
    else:
        missing_packets = sorted(required_packets - set(packet_schemas))
        if missing_packets:
            issues.append(
                "decision_packet_schemas_missing:" + ",".join(missing_packets)
            )

    capabilities = contract.get("capabilities")
    if not isinstance(capabilities, list):
        issues.append("capabilities_missing")
    else:
        capability_set = set(capabilities)
        missing_capabilities = [
            item
            for item in PROFILE_COMPATIBILITY["required_capabilities"]
            if item not in capability_set
        ]
        if missing_capabilities:
            issues.append(
                "capabilities_missing:" + ",".join(missing_capabilities)
            )

    semantic_revisions = contract.get("semantic_revisions")
    if not isinstance(semantic_revisions, dict):
        issues.append("semantic_revisions_missing")
    else:
        for name, expected in PROFILE_COMPATIBILITY["required_semantic_revisions"].items():
            if semantic_revisions.get(name) != expected:
                issues.append(f"semantic_revision_mismatch:{name}")

    acceptance = contract.get("provider_acceptance_evidence")
    if not isinstance(acceptance, dict):
        issues.append("provider_acceptance_evidence_missing")
    else:
        for name, expected in PROFILE_COMPATIBILITY["required_provider_acceptance_evidence"].items():
            if acceptance.get(name) != expected:
                issues.append(f"provider_acceptance_evidence_mismatch:{name}")

    if contract.get("paired_manifest_schema") != PROFILE_COMPATIBILITY["paired_manifest_schema"]:
        issues.append("paired_manifest_schema_mismatch")

    return issues


def verify_gateway_compatibility(health: dict[str, Any]) -> None:
    issues = compatibility_issues(health)
    if issues:
        raise RuntimeError("gateway_incompatible:" + ";".join(issues))


def compatibility_summary(health: dict[str, Any]) -> str:
    contract = health.get("compatibility")
    if not isinstance(contract, dict):
        return "incompatible (gateway_missing_compatibility_contract)"
    issues = compatibility_issues(health)
    if issues:
        return "incompatible (" + "; ".join(issues) + ")"
    gateway_version = str(contract.get("gateway_version") or "unknown")
    return (
        f"compatible (profile {PROFILE_COMPATIBILITY['profile_version']}, "
        f"gateway {gateway_version})"
    )
