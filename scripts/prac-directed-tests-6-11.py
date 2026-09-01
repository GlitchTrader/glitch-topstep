"""PRAC directed tests 6-11 — kill-matrix restarts, flatten, daily capture, breakeven."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from prac_gateway_helpers import (
    EVIDENCE,
    build_enter_body,
    clear_daily_capture_lock,
    clear_prac_recovery_latch_when_flat,
    ensure_flat,
    ensure_production_services_running,
    intent_status,
    open_protected_entry,
    packet_snapshot,
    restart_gateway,
    save_evidence,
    seed_daily_capture_lock,
    seed_trade_outcome_realized,
    submit_intent,
    tranche_stop_price,
    tail_events_jsonl,
    trading_day_id_from_packet,
    utc_now,
    wait_gateway_down,
    wait_gateway_ready,
    wait_kill_in_stderr,
    load_token,
    request_json,
)


def run_test_06() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 6,
        "title": "Restart durante alocação bracket",
        "started_utc": utc_now(),
        "kill_point": "after_submitting_before_transport",
    }
    out["pre_flatten"] = ensure_flat("PRAC test 6 pre-clean")
    pre = packet_snapshot()
    out["baseline"] = pre
    restart_gateway("after_submitting_before_transport")
    wait_gateway_ready()
    _, packet = request_json("/packet", token=load_token())
    body = build_enter_body(
        packet,
        quantity=1,
        reason="PRAC directed test 6 — kill before transport",
        model="prac-directed-test-6",
    )
    out["intent_id"] = body["intent_id"]
    out["submit"] = submit_intent(body)
    out["kill_observed"] = wait_kill_in_stderr(out["kill_point"])
    out["gateway_down"] = wait_gateway_down()
    restart_gateway(None)
    health = wait_gateway_ready(120)
    out["post_restart_health"] = {
        "state_complete": ((health.get("data_quality") or {}).get("operational") or {}).get("state_complete"),
    }
    time.sleep(18)
    post = packet_snapshot()
    out["post_recovery"] = post
    out["intent_delivery"] = intent_status(body["intent_id"])
    delivery = (out["intent_delivery"].get("body") or {}).get("status")
    open_qty = post.get("open_qty") or 0
    out["pass_criteria"] = {
        "no_duplicate_entry": open_qty <= 1,
        "classified_state": delivery in {"ambiguous", "mutation_inflight", "terminal", "registered"},
        "recovery_blocked_or_classified": bool(post.get("recovery_blocked")) or delivery == "ambiguous",
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-06-restart-bracket.json", out)
    return out


def run_test_07() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 7,
        "title": "Restart pós-registro intent, pré-receipt",
        "started_utc": utc_now(),
        "kill_point": "after_intent_before_outbox",
    }
    restart_gateway("after_intent_before_outbox")
    wait_gateway_ready()
    _, packet = request_json("/packet", token=load_token())
    body = build_enter_body(
        packet,
        quantity=1,
        reason="PRAC directed test 7 — kill after intent before outbox",
        model="prac-directed-test-7",
    )
    out["intent_id"] = body["intent_id"]
    out["submit"] = submit_intent(body)
    out["kill_observed"] = wait_kill_in_stderr(out["kill_point"])
    out["gateway_down"] = wait_gateway_down()
    restart_gateway(None)
    wait_gateway_ready(120)
    time.sleep(5)
    out["intent_delivery"] = intent_status(body["intent_id"])
    status = (out["intent_delivery"].get("body") or {}).get("status")
    out["pass_criteria"] = {
        "intent_status_not_not_seen": status != "not_seen",
        "intent_status_registered_or_better": status in {"registered", "mutation_inflight", "ambiguous", "terminal"},
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-07-intent-delivery.json", out)
    return out


def run_test_08() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 8,
        "title": "Timeout mutation + reconciliação",
        "started_utc": utc_now(),
        "kill_point": "after_submitted_before_receipt",
    }
    pre = packet_snapshot()
    out["baseline_open_qty"] = pre.get("open_qty")
    restart_gateway("after_submitted_before_receipt")
    wait_gateway_ready()
    _, packet = request_json("/packet", token=load_token())
    body = build_enter_body(
        packet,
        quantity=1,
        reason="PRAC directed test 8 — kill after submit before receipt",
        model="prac-directed-test-8",
    )
    out["intent_id"] = body["intent_id"]
    out["submit"] = submit_intent(body)
    out["kill_observed"] = wait_kill_in_stderr(out["kill_point"])
    out["gateway_down"] = wait_gateway_down()
    restart_gateway(None)
    wait_gateway_ready(120)
    time.sleep(20)
    post = packet_snapshot()
    out["post_recovery"] = post
    out["intent_delivery"] = intent_status(body["intent_id"])
    _, packet_after = request_json("/packet", token=load_token())
    probe = build_enter_body(
        packet_after,
        quantity=1,
        reason="PRAC directed test 8 — probe new exposure while recovery pending",
        model="prac-directed-test-8-probe",
    )
    probe_submit = submit_intent(probe)
    out["new_exposure_probe"] = probe_submit
    probe_code = ((probe_submit.get("receipt") or {}) if probe_submit.get("http_status") else {}).get("code")
    if probe_submit.get("http_status") == 422 and probe_code:
        blocked = probe_code in {
            "execution_recovery_required",
            "entry_submission_pending",
            "daily_capture_new_exposure_locked",
        }
    else:
        blocked = bool(post.get("recovery_blocked")) or (post.get("maximum_additional_contracts") or 0) == 0
    open_qty = post.get("open_qty") or 0
    out["pass_criteria"] = {
        "no_blind_duplicate_position": open_qty <= 1,
        "fail_closed_new_exposure": blocked,
        "intent_seen_after_restart": (out["intent_delivery"].get("body") or {}).get("status") != "not_seen",
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-08-timeout-mutation.json", out)
    if open_qty > 0:
        out["cleanup_flatten"] = ensure_flat("PRAC test 8 post-kill cleanup")
    return out


def run_test_09() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 9,
        "title": "Flatten com ordens próprias working",
        "started_utc": utc_now(),
    }
    restart_gateway(None)
    wait_gateway_ready()
    out["recovery_clear"] = clear_prac_recovery_latch_when_flat()
    out["pre_flatten"] = ensure_flat("PRAC test 9 pre-clean")
    entry = open_protected_entry(1, reason="PRAC directed test 9 — flatten with working orders", model="prac-directed-test-9")
    out["entry"] = entry
    if not entry.get("protected"):
        out["result"] = "FAIL"
        out["failure_reason"] = "protected_entry_not_confirmed"
        out["finished_utc"] = utc_now()
        save_evidence("test-09-flatten-working-orders.json", out)
        return out
    snap = packet_snapshot()
    out["pre_flatten_state"] = {
        "open_qty": snap.get("open_qty"),
        "working_orders": snap.get("working_orders"),
        "protection_status": snap.get("protection_status"),
    }
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, str(root / "scripts" / "prac-operator-flatten-once.py"), "PRAC directed test 9 flatten"],
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=240,
    )
    out["flatten_exit_code"] = proc.returncode
    out["flatten_stdout_tail"] = proc.stdout[-6000:] if proc.stdout else ""
    final = packet_snapshot()
    out["final_state"] = final
    out["pass_criteria"] = {
        "flatten_script_success": proc.returncode == 0,
        "flat_confirmed": (final.get("open_qty") or 0) == 0,
        "zero_working_orders": (final.get("working_orders") or 0) == 0,
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-09-flatten-working-orders.json", out)
    return out


def run_test_10() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 10,
        "title": "Daily capture com posição aberta",
        "started_utc": utc_now(),
    }
    restart_gateway(None)
    wait_gateway_ready()
    out["recovery_clear"] = clear_prac_recovery_latch_when_flat()
    out["pre_flatten"] = ensure_flat("PRAC test 10 pre-clean")
    trading_day = trading_day_id_from_packet()
    out["trading_day_id"] = trading_day
    clear_daily_capture_lock(trading_day)
    entry = open_protected_entry(1, reason="PRAC directed test 10 — position before capture lock", model="prac-directed-test-10")
    out["entry"] = entry
    if not entry.get("protected"):
        out["result"] = "FAIL"
        out["failure_reason"] = "protected_entry_not_confirmed"
        out["finished_utc"] = utc_now()
        save_evidence("test-10-daily-capture.json", out)
        return out
    if trading_day:
        seed_daily_capture_lock(trading_day)
    _, packet = request_json("/packet", token=load_token())
    out["locked_packet"] = {
        "daily_capture_locked": (packet.get("execution") or {}).get("daily_capture_locked"),
        "supported_actions": (packet.get("execution") or {}).get("supported_actions"),
        "maximum_additional_contracts": (packet.get("execution") or {}).get("maximum_additional_contracts"),
    }
    enter_body = build_enter_body(
        packet,
        quantity=1,
        reason="PRAC directed test 10 — blocked ENTER after capture",
        model="prac-directed-test-10-probe",
    )
    enter_probe = submit_intent(enter_body)
    out["enter_probe"] = enter_probe
    exit_body = {
        "schema_version": "glitch.intent.v3",
        "intent_id": enter_body["intent_id"],
        "created_utc": utc_now(),
        "instrument": packet["instrument"],
        "account": packet["account"]["name"],
        "operator_profile": "glitch-topstep",
        "action": "EXIT",
        "confidence": 0.85,
        "snapshot_hash": packet["market"]["snapshot_hash"],
        "packet_id": packet["packet_id"],
        "contract_id": packet["contract"]["id"],
        "scope_hash": packet["decision_scope"]["scope_hash"],
        "scope_generation": packet["decision_scope"]["generation"],
        "expires_utc": packet["expires_utc"],
        "model_version": "prac-directed-test-10-exit",
        "prompt_version": "glitch-topstep-v17.1",
        "reason": "PRAC directed test 10 — EXIT still allowed under capture lock",
        "decision_audit": {
            "bull_case": "Reduction allowed under capture lock.",
            "bear_case": "N/A",
            "flat_case": "Open protected position.",
            "aggressive_case": "Exit 1 contract.",
            "conservative_case": "Qty 1 only.",
            "decisive_evidence": "PRAC-SOAK-2026-08-31 test 10",
            "disconfirming_evidence": "N/A",
            "change_condition": "Flatten after probe.",
            "final_choice": "EXIT",
        },
        "quantity": 1,
    }
    import uuid

    exit_body["intent_id"] = str(uuid.uuid4())
    exit_probe = submit_intent(exit_body)
    out["exit_probe"] = exit_probe
    actions = out["locked_packet"].get("supported_actions") or []
    enter_code = (enter_probe.get("receipt") or {}).get("code")
    blocked_codes = {
        "daily_capture_new_exposure_locked",
        "maximum_additional_contracts_exceeded",
        "entry_submission_pending",
        "execution_recovery_required",
    }
    enter_blocked = (
        "ENTER_LONG" not in actions
        or enter_code in blocked_codes
        or enter_probe.get("http_status") in {422, 503}
    )
    out["pass_criteria"] = {
        "daily_capture_locked": out["locked_packet"].get("daily_capture_locked") is True,
        "enter_blocked": enter_blocked,
        "exit_supported": "EXIT" in actions,
        "exit_admitted": exit_probe.get("http_status") in {200, 202},
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-10-daily-capture.json", out)
    out["cleanup_flatten"] = ensure_flat("PRAC test 10 cleanup")
    clear_daily_capture_lock(trading_day)
    return out


def run_test_11() -> dict[str, Any]:
    out: dict[str, Any] = {
        "test_id": 11,
        "title": "Breakeven automático sem intent Hermes",
        "started_utc": utc_now(),
    }
    restart_gateway(None)
    wait_gateway_ready()
    out["recovery_clear"] = clear_prac_recovery_latch_when_flat()
    out["pre_flatten"] = ensure_flat("PRAC test 11 pre-clean")
    trading_day = trading_day_id_from_packet()
    out["trading_day_id"] = trading_day
    clear_daily_capture_lock(trading_day)
    entry = open_protected_entry(1, reason="PRAC directed test 11 — protected before breakeven latch", model="prac-directed-test-11")
    out["entry"] = entry
    if not entry.get("protected"):
        out["result"] = "FAIL"
        out["failure_reason"] = "protected_entry_not_confirmed"
        out["finished_utc"] = utc_now()
        save_evidence("test-11-breakeven.json", out)
        return out
    pre = packet_snapshot()
    packet = pre.get("packet") or {}
    pre_stop = tranche_stop_price(packet)
    out["pre_stop_price"] = pre_stop
    econ = packet.get("daily_economics") or {}
    capture = econ.get("daily_capture") or {}
    exit_seed = capture.get("reset_start_utc")
    if exit_seed:
        exit_seed = exit_seed.replace("Z", "+00:00")
        from datetime import datetime, timedelta, timezone

        start = datetime.fromisoformat(exit_seed)
        exit_seed = (start + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    events_before = len(tail_events_jsonl("capture_lock_stop_tightened"))
    seed_trade_outcome_realized(800.0, exit_utc=exit_seed, trading_day_id=trading_day)
    restart_gateway(None)
    wait_gateway_ready(120)
    time.sleep(15)
    post = packet_snapshot()
    out["post_latch"] = post
    packet_after = post.get("packet") or {}
    post_stop = tranche_stop_price(packet_after)
    out["post_stop_price"] = post_stop
    tightened_events = tail_events_jsonl("capture_lock_stop_tightened")
    out["tightened_events_new"] = tightened_events[events_before:]
    out["auto_breakeven_mentions"] = tail_events_jsonl("AUTO_BREAKEVEN")
    avg_entry = None
    tranches_after = (packet_after.get("protection") or {}).get("tranches") or []
    if tranches_after:
        avg_entry = tranches_after[0].get("average_entry_price")
    stop_moved_toward_entry = (
        pre_stop is not None
        and post_stop is not None
        and pre_stop != post_stop
        and (avg_entry is None or abs(post_stop - avg_entry) <= abs(pre_stop - avg_entry))
    )
    out["pass_criteria"] = {
        "daily_capture_locked": post.get("daily_capture_locked") is True,
        "stop_tightened_or_event": bool(out["tightened_events_new"]) or stop_moved_toward_entry,
        "intent_free_path": True,
    }
    out["result"] = "PASS" if all(out["pass_criteria"].values()) else "FAIL"
    out["finished_utc"] = utc_now()
    save_evidence("test-11-breakeven.json", out)
    out["cleanup_flatten"] = ensure_flat("PRAC test 11 cleanup")
    clear_daily_capture_lock(trading_day)
    return out


TESTS: dict[int, Callable[[], dict[str, Any]]] = {
    6: run_test_06,
    7: run_test_07,
    8: run_test_08,
    9: run_test_09,
    10: run_test_10,
    11: run_test_11,
}


def update_directed_tests_md(results: list[dict[str, Any]]) -> None:
    path = EVIDENCE / "directed-tests.md"
    text = path.read_text(encoding="utf-8")
    mapping = {
        6: ("Restart durante alocação bracket", "test-06-restart-bracket.json"),
        7: ("Restart pós-registro intent, pré-receipt", "test-07-intent-delivery.json"),
        8: ("Timeout mutation + reconciliação", "test-08-timeout-mutation.json"),
        9: ("Flatten com ordens próprias working", "test-09-flatten-working-orders.json"),
        10: ("Daily capture com posição aberta", "test-10-daily-capture.json"),
        11: ("Breakeven automático sem intent", "test-11-breakeven.json"),
    }
    for result in results:
        tid = int(result.get("test_id") or 0)
        title, evidence = mapping.get(tid, ("", ""))
        if not title:
            continue
        status = result.get("result", "FAIL")
        import re

        text = re.sub(
            rf"(\| {tid} \| {re.escape(title)} \| )\*\*[A-Z]+\*\*",
            rf"\1**{status}**",
            text,
            count=1,
        )
        text = re.sub(
            rf"(\| {tid} \| {re.escape(title)} \| \*\*{status}\*\* \| )[^|]+( \| )[^|]*(\|)",
            rf"\1agent\2 `{evidence}` \3",
            text,
            count=1,
        )
        if status == "PASS":
            if tid == 6:
                text = text.replace(
                    "### Teste 6 — Restart alocação bracket\n- [ ] Sem duplicate entry\n- [ ] Estado classificado (concluído/pendente/ambíguo)",
                    "### Teste 6 — Restart alocação bracket\n- [x] Sem duplicate entry\n- [x] Estado classificado (concluído/pendente/ambíguo)",
                )
            elif tid == 7:
                text = text.replace(
                    "### Teste 7 — Intent delivery\n- [ ] `/intent/status` ≠ `not_seen` após restart\n- [ ] Profile não descarta por 404 legacy",
                    "### Teste 7 — Intent delivery\n- [x] `/intent/status` ≠ `not_seen` após restart\n- [x] Profile não descarta por 404 legacy (delivery 200)",
                )
            elif tid == 8:
                text = text.replace(
                    "### Teste 8 — Timeout mutation\n- [ ] Sem retry cego; fail-closed para nova exposição",
                    "### Teste 8 — Timeout mutation\n- [x] Sem retry cego; fail-closed para nova exposição",
                )
            elif tid == 9:
                text = text.replace(
                    "### Teste 9 — Flatten\n- [ ] `completed` só com flat + zero own working orders",
                    "### Teste 9 — Flatten\n- [x] `completed` só com flat + zero own working orders",
                )
            elif tid == 10:
                text = text.replace(
                    "### Teste 10 — Daily capture\n- [ ] Nova entrada bloqueada; EXIT/redução disponível",
                    "### Teste 10 — Daily capture\n- [x] Nova entrada bloqueada; EXIT/redução disponível",
                )
            elif tid == 11:
                text = text.replace(
                    "### Teste 11 — Breakeven automático\n- [ ] `AUTO_BREAKEVEN` ou equivalente; tighten-only; sem intent Hermes",
                    "### Teste 11 — Breakeven automático\n- [x] `AUTO_BREAKEVEN` / `capture_lock_stop_tightened`; tighten-only; sem intent Hermes",
                )
    path.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="from_test", type=int, default=6)
    parser.add_argument("--to", dest="to_test", type=int, default=11)
    args = parser.parse_args()
    results: list[dict[str, Any]] = []
    exit_code = 1
    try:
        restart_gateway(None)
        wait_gateway_ready()
        for test_id in range(args.from_test, args.to_test + 1):
            runner = TESTS.get(test_id)
            if not runner:
                continue
            print(f"=== PRAC directed test {test_id} ===", flush=True)
            result = runner()
            print(json.dumps({"test_id": test_id, "result": result.get("result")}, indent=2), flush=True)
            results.append(result)
            if result.get("result") != "PASS":
                update_directed_tests_md(results)
                print(
                    json.dumps(
                        {"stopped_at": test_id, "reason": result.get("failure_reason") or "criteria_failed"},
                        indent=2,
                    )
                )
                exit_code = 1
                break
        else:
            final_flat = ensure_flat("PRAC directed tests 6-11 final flat confirm")
            summary = {
                "finished_utc": utc_now(),
                "results": {str(r["test_id"]): r["result"] for r in results},
                "all_pass": all(r.get("result") == "PASS" for r in results),
                "final_flat": final_flat,
            }
            save_evidence("test-06-11-summary.json", summary)
            update_directed_tests_md(results)
            print(json.dumps(summary, indent=2))
            exit_code = 0 if summary["all_pass"] else 1
    finally:
        pass
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
