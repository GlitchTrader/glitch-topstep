"""distribution.yaml + SHA256SUMS helpers for installs, CI, and safe updates."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

DISTRIBUTION_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_FILENAME = "distribution.yaml"
SHA256SUMS_FILENAME = "SHA256SUMS"

# ponytail: Hermes copies staged top-level entries verbatim; never ship VCS metadata
# into %LOCALAPPDATA%\\hermes\\profiles\\* or Windows updates fail on rmtree(.git).
STAGING_ARTIFACTS = frozenset({".git", ".gitattributes"})

PROMPT_VERSION = "glitch-topstep-v10"
MIN_GATEWAY_VERSION = "0.2.0"
TESTED_GATEWAY_VERSION = "0.2.0"


def read_distribution_version(root: Path | None = None) -> str:
    root = root or DISTRIBUTION_ROOT
    path = root / MANIFEST_FILENAME
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r'^version:\s*["\']?([^"\'\s]+)', line.strip())
        if match:
            return match.group(1)
    raise RuntimeError(f"{MANIFEST_FILENAME} missing version")


def iter_sha256sums_entries(root: Path | None = None):
    root = root or DISTRIBUTION_ROOT
    manifest = root / SHA256SUMS_FILENAME
    for line in manifest.read_text(encoding="utf-8").splitlines():
        line = line.lstrip("\ufeff").strip()
        if not line:
            continue
        parts = re.split(r"\s{2,}", line, maxsplit=1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9A-Fa-f]{64}", parts[0]):
            raise ValueError(f"invalid SHA256SUMS line: {line}")
        yield parts[0].upper(), parts[1]


def file_sha256(path: Path) -> str:
    data = path.read_bytes()
    # ponytail: CRLF on Windows must hash the same as LF from git clone installs
    data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest().upper()


def verify_sha256sums(root: Path | None = None) -> list[str]:
    root = root or DISTRIBUTION_ROOT
    errors: list[str] = []
    for expected, relative in iter_sha256sums_entries(root):
        path = root / Path(relative)
        if not path.is_file():
            errors.append(f"missing: {relative}")
            continue
        actual = file_sha256(path)
        if actual != expected:
            errors.append(f"mismatch: {relative}")
    return errors


def regenerate_sha256sums(root: Path | None = None) -> list[str]:
    root = root or DISTRIBUTION_ROOT
    lines: list[str] = []
    included_roots = {
        ".env.EXAMPLE", ".github", ".gitignore", "README.md", "SOUL.md",
        "config.yaml", "distribution.yaml", "docs", "operator.json", "plugins",
        "scripts", "setup.ps1", "skills", "tests",
    }
    paths = sorted(
        path for path in root.rglob("*")
        if path.is_file()
        and path.name != SHA256SUMS_FILENAME
        and path.parts[len(root.parts)] in included_roots
        and ".git" not in path.parts
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
    )
    for path in paths:
        relative = path.relative_to(root).as_posix()
        lines.append(f"{file_sha256(path)}  {relative}")
    (root / SHA256SUMS_FILENAME).write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return lines
