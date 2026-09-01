#!/usr/bin/env python3
"""Regenerate SHA256SUMS from the current tree. Run before release commits."""

from __future__ import annotations

from distribution_manifest import regenerate_sha256sums


def main() -> None:
    lines = regenerate_sha256sums()
    print(f"SHA256SUMS regenerated ({len(lines)} entries)")


if __name__ == "__main__":
    main()
