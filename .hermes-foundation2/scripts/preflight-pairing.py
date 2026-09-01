#!/usr/bin/env python3
"""Verify Hermes profile prompt_version pairing with the local glitch-topstep gateway."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from distribution_manifest import PROMPT_VERSION, TESTED_GATEWAY_VERSION


def _gateway_prompt_version(gateway_root: Path) -> str | None:
    operator = gateway_root / "src" / "domain" / "operator.ts"
    if not operator.is_file():
        return None
    match = re.search(
        r'GLITCH_TOPSTEP_PROMPT_VERSION\s*=\s*"([^"]+)"',
        operator.read_text(encoding="utf-8"),
    )
    return match.group(1) if match else None


def _health(url: str, token: str | None, timeout: float) -> dict:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gateway-root",
        type=Path,
        help="Local glitch-topstep clone (reads src/domain/operator.ts)",
    )
    parser.add_argument(
        "--health-url",
        default="http://127.0.0.1:8790/health",
        help="Gateway health endpoint",
    )
    parser.add_argument("--token", default=None, help="Bearer token for /health")
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()

    failures: list[str] = []
    print(f"profile PROMPT_VERSION={PROMPT_VERSION}")
    print(f"profile TESTED_GATEWAY_VERSION={TESTED_GATEWAY_VERSION}")

    if args.gateway_root:
        gateway_version = _gateway_prompt_version(args.gateway_root)
        if gateway_version is None:
            failures.append(f"could not read GLITCH_TOPSTEP_PROMPT_VERSION from {args.gateway_root}")
        elif gateway_version != PROMPT_VERSION:
            failures.append(
                f"gateway operator.ts prompt version {gateway_version!r} != profile {PROMPT_VERSION!r}"
            )
        else:
            print(f"gateway operator.ts prompt version matches ({gateway_version})")

    try:
        health = _health(args.health_url, args.token, args.timeout)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        failures.append(f"GET {args.health_url} failed: {error}")
    else:
        compatibility = health.get("compatibility") or {}
        gateway_build = compatibility.get("gateway_version")
        print(f"gateway /health compatibility.gateway_version={gateway_build!r}")
        if gateway_build and gateway_build != TESTED_GATEWAY_VERSION:
            print(
                f"warning: tested gateway version drift ({TESTED_GATEWAY_VERSION} profile vs {gateway_build} live)",
                file=sys.stderr,
            )

    if failures:
        for item in failures:
            print(f"FAIL: {item}", file=sys.stderr)
        print(
            "Repair: pull/restart gateway, run scripts/sync-glitch-topstep-prompt-v9.sh, "
            "then re-run this preflight.",
            file=sys.stderr,
        )
        return 1

    print("OK: prompt pairing preflight passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
