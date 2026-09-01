"""Compare two prompt-version decision runs over one immutable frame corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def read_run(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != "glitch.topstep.cognition_run.v1":
        raise ValueError(f"invalid cognition run: {path}")
    if not isinstance(value.get("decisions"), list):
        raise ValueError(f"decisions missing: {path}")
    return value


def compare_runs(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    if baseline.get("corpus_hash") != candidate.get("corpus_hash"):
        raise ValueError("frozen_corpus_hash_mismatch")
    if baseline.get("prompt_version") == candidate.get("prompt_version"):
        raise ValueError("prompt_versions_must_differ")
    base = {str(row["frame_id"]): row for row in baseline["decisions"]}
    other = {str(row["frame_id"]): row for row in candidate["decisions"]}
    if set(base) != set(other):
        raise ValueError("frame_set_mismatch")
    diffs = []
    for frame_id in sorted(base):
        left, right = base[frame_id], other[frame_id]
        changed = [
            field for field in ("action", "rejection", "abstention_classification")
            if left.get(field) != right.get(field)
        ]
        if changed:
            diffs.append({
                "frame_id": frame_id,
                "changed_fields": changed,
                "baseline": {field: left.get(field) for field in changed},
                "candidate": {field: right.get(field) for field in changed},
            })
    return {
        "schema_version": "glitch.topstep.cognition_diff.v1",
        "evaluation_only": True,
        "armed_promotion_allowed": False,
        "corpus_hash": baseline["corpus_hash"],
        "baseline_prompt_version": baseline["prompt_version"],
        "candidate_prompt_version": candidate["prompt_version"],
        "frames_compared": len(base),
        "changed_frames": len(diffs),
        "diffs": diffs,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = compare_runs(read_run(args.baseline), read_run(args.candidate))
    report["baseline_artifact_hash"] = file_hash(args.baseline)
    report["candidate_artifact_hash"] = file_hash(args.candidate)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
