"""Idempotently patch Hermes profile_distribution.py for Windows-safe updates.

The glitch-topstep profile relies on excluding VCS metadata from distribution
staging and using a robust rmtree on Windows. Hermes upstream may not ship
this yet; this script re-applies the local patch after Hermes agent updates.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

PATCH_MARKER = "glitch-topstep-distribution-patch-v1"

STAGING_EXCLUDE_BLOCK = f'''
# {PATCH_MARKER}
# Paths that are NEVER copied into an installed profile or used as staging
# payload.  VCS metadata breaks Windows updates when Hermes tries to replace
# distribution-owned directories.
DISTRIBUTION_STAGING_EXCLUDE: frozenset = frozenset({{
    ".git",
    ".gitattributes",
}})

'''

HELPER_FUNCTIONS = '''
def _rmtree_robust(path: Path) -> None:
    """Windows-safe rmtree for read-only git objects and profile locks."""
    import os
    import stat

    def _onerror(func, p, exc_info):
        if not os.access(p, os.W_OK):
            os.chmod(p, stat.S_IWUSR)
            func(p)
        else:
            raise exc_info[1]

    shutil.rmtree(path, onerror=_onerror)


def _stage_local_directory(source: Path, workdir: Path) -> Path:
    """Copy a local distribution tree without VCS metadata."""
    staged = workdir / "local"

    def _ignore(directory: str, names: list[str]) -> list[str]:
        ignored = set(DISTRIBUTION_STAGING_EXCLUDE) | set(USER_OWNED_EXCLUDE)
        if Path(directory).resolve() == source.resolve():
            return [n for n in names if n in ignored]
        return []

    shutil.copytree(source, staged, ignore=_ignore, dirs_exist_ok=True)
    return staged


def _remove_staging_artifacts(target: Path) -> None:
    for name in DISTRIBUTION_STAGING_EXCLUDE:
        artifact = target / name
        if not artifact.exists():
            continue
        if artifact.is_dir():
            _rmtree_robust(artifact)
        else:
            artifact.unlink()


'''


def find_profile_distribution_py() -> Path:
    candidates: list[Path] = []
    hermes = shutil.which("hermes")
    if hermes:
        root = Path(hermes).resolve().parent.parent
        candidates.append(root / "hermes_cli" / "profile_distribution.py")
        candidates.append(root / "hermes-agent" / "hermes_cli" / "profile_distribution.py")
    localappdata = os.environ.get("LOCALAPPDATA", "")
    if localappdata:
        candidates.append(
            Path(localappdata)
            / "hermes"
            / "hermes-agent"
            / "hermes_cli"
            / "profile_distribution.py"
        )
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    raise FileNotFoundError(
        "Could not locate Hermes profile_distribution.py; is Hermes installed?"
    )


def is_patched(text: str) -> bool:
    return (
        "DISTRIBUTION_STAGING_EXCLUDE" in text
        and "_rmtree_robust" in text
        and "_stage_local_directory" in text
        and "_remove_staging_artifacts" in text
        and "_rmtree_robust(dest)" in text
    )


def apply_patch(text: str) -> tuple[str, list[str]]:
    if is_patched(text):
        return text, []

    changes: list[str] = []

    if "DISTRIBUTION_STAGING_EXCLUDE" not in text:
        needle = (
            ")\n\n# Paths that are NEVER part of a distribution. These are user-owned and are"
        )
        if needle not in text:
            raise RuntimeError("unexpected Hermes profile_distribution.py layout (staging exclude)")
        text = text.replace(needle, f"){STAGING_EXCLUDE_BLOCK}\n# Paths that are NEVER part of a distribution. These are user-owned and are", 1)
        changes.append("staging_exclude")

    if "def _rmtree_robust" not in text:
        needle = "\ndef _stage_source(source: str, workdir: Path)"
        if needle not in text:
            raise RuntimeError("unexpected Hermes profile_distribution.py layout (helpers)")
        text = text.replace(needle, f"\n{HELPER_FUNCTIONS}\ndef _stage_source(source: str, workdir: Path)", 1)
        changes.append("helper_functions")

    old_git_cleanup = (
        "        _git_clone(src_str, cloned)\n"
        "        # Remove .git to keep the staged tree clean\n"
        "        shutil.rmtree(cloned / \".git\", ignore_errors=True)"
    )
    new_git_cleanup = (
        "        _git_clone(src_str, cloned)\n"
        "        git_dir = cloned / \".git\"\n"
        "        if git_dir.exists():\n"
        "            _rmtree_robust(git_dir)"
    )
    if old_git_cleanup in text:
        text = text.replace(old_git_cleanup, new_git_cleanup, 1)
        changes.append("git_cleanup")
    elif new_git_cleanup not in text:
        raise RuntimeError("unexpected Hermes profile_distribution.py layout (git cleanup)")

    old_local = "        return path_guess.resolve(), str(path_guess.resolve())"
    new_local = (
        "        staged = _stage_local_directory(path_guess.resolve(), workdir)\n"
        "        return staged, str(path_guess.resolve())"
    )
    if old_local in text:
        text = text.replace(old_local, new_local, 1)
        changes.append("local_stage")
    elif new_local not in text:
        raise RuntimeError("unexpected Hermes profile_distribution.py layout (local stage)")

    staging_skip = (
        "        if name in USER_OWNED_EXCLUDE:\n"
        "            continue\n"
        "        if name in DISTRIBUTION_STAGING_EXCLUDE:\n"
        "            continue"
    )
    if staging_skip not in text:
        text = text.replace(
            "        if name in USER_OWNED_EXCLUDE:\n            continue\n",
            staging_skip + "\n",
            1,
        )
        changes.append("copy_skip_staging")

    if "shutil.rmtree(dest)" in text:
        text = text.replace("shutil.rmtree(dest)", "_rmtree_robust(dest)", 1)
        changes.append("rmtree_robust")

    old_ignore = (
        "[n for n in names if n in USER_OWNED_EXCLUDE]\n"
        "                    if Path(d).resolve() == staged_resolved"
    )
    new_ignore = (
        "[n for n in names if n in USER_OWNED_EXCLUDE or n in DISTRIBUTION_STAGING_EXCLUDE]\n"
        "                    if Path(d).resolve() == staged_resolved"
    )
    if old_ignore in text:
        text = text.replace(old_ignore, new_ignore, 1)
        changes.append("copytree_ignore")

    cleanup_tail = (
        "    write_manifest(target, manifest)\n"
        "    _remove_staging_artifacts(target)"
    )
    if cleanup_tail not in text:
        text = text.replace(
            "    write_manifest(target, manifest)\n",
            cleanup_tail + "\n",
            1,
        )
        changes.append("remove_staging_artifacts")

    if not is_patched(text):
        raise RuntimeError("patch application incomplete")

    return text, changes


def ensure_patch(dry_run: bool = False) -> dict[str, object]:
    target = find_profile_distribution_py()
    original = target.read_text(encoding="utf-8")
    if is_patched(original):
        return {
            "state": "already_patched",
            "path": str(target),
            "marker": PATCH_MARKER,
        }

    patched, changes = apply_patch(original)
    if dry_run:
        return {
            "state": "would_patch",
            "path": str(target),
            "changes": changes,
            "marker": PATCH_MARKER,
        }

    backup = target.with_suffix(".py.glitch-topstep.bak")
    backup.write_text(original, encoding="utf-8")
    target.write_text(patched, encoding="utf-8")
    return {
        "state": "patched",
        "path": str(target),
        "backup": str(backup),
        "changes": changes,
        "marker": PATCH_MARKER,
    }


def main() -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        result = ensure_patch(dry_run=args.dry_run)
    except (FileNotFoundError, RuntimeError, OSError) as error:
        print(json.dumps({"state": "error", "error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
