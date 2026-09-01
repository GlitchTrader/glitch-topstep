"""One-shot live gateway packet → Hermes prompt → intent (evaluation only, no delivery)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    profile = Path(
        os.environ.get("GLITCH_TOPSTEP_PROFILE_ROOT", "")
        or Path(os.environ["LOCALAPPDATA"]) / "hermes" / "profiles" / "glitch-topstep"
    ).resolve()
    scripts = profile / "scripts"
    out_dir = Path(__file__).resolve().parent.parent / "docs" / "evidence"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%MZ")

    sys.path.insert(0, str(scripts))
    os.chdir(scripts)
    os.environ["HERMES_HOME"] = str(profile)

    spec = importlib.util.spec_from_file_location(
        "run_topstep_cycle_eval", scripts / "run-topstep-cycle.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("failed_to_load_cycle_module")
    cycle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cycle)

    from common import local_token, request_json, state_root, verify_gateway_compatibility
    from parity import active_trade_state

    root = cycle.configure_environment(profile)
    state = state_root(root)
    token = local_token()

    health_status, health = request_json("/health")
    verify_gateway_compatibility(health)
    packet_status, packet = request_json("/packet", token=token)
    if packet_status != 200 or not isinstance(packet, dict):
        print(json.dumps({"error": "packet_fetch_failed", "status": packet_status}))
        return 1

    cycle.capture_frame(packet, state)
    frames = cycle.cycle_recent_frames(state, packet)
    context = cycle.recent_context(state)
    trade_state = active_trade_state(state, packet)
    prompt = cycle.build_prompt(
        packet,
        frames,
        context,
        None,
        trade_state,
        invocation_reason="operator_eval",
    )

    timeout = int(os.environ.get("GLITCH_TOPSTEP_MODEL_TIMEOUT_SECONDS", "240"))
    positioned = cycle.positioned(packet)
    intent = cycle.invoke_hermes(
        cycle.PROFILE_NAME,
        prompt,
        timeout,
        positioned_only=positioned,
    )

    template = packet.get("required_output_template") or {}
    band = packet.get("entry_band_guidance") or {}
    meta = {
        "schema_version": "glitch.topstep.prompt_eval.v1",
        "recorded_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "packet_id": packet.get("packet_id"),
        "instrument": packet.get("instrument"),
        "created_utc": packet.get("created_utc"),
        "gateway_version": health.get("compatibility", {}).get("gateway_version"),
        "profile_version": health.get("compatibility", {}).get("profile_version"),
        "prompt_version": cycle.PROMPT_VERSION,
        "prompt_chars": len(prompt),
        "frame_count": len(frames),
        "positioned": positioned,
        "entry_band_guidance": band,
        "template_entry_min": template.get("entry_price_min"),
        "template_entry_max": template.get("entry_price_max"),
        "intent_action": intent.get("action"),
        "intent_entry_min": intent.get("entry_price_min"),
        "intent_entry_max": intent.get("entry_price_max"),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"entry-parity-prompt-eval-{stamp}"
    base.with_suffix(".prompt.txt").write_text(prompt, encoding="utf-8")
    base.with_suffix(".intent.json").write_text(
        json.dumps(intent, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    base.with_suffix(".meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(json.dumps(meta, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
