import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import ensure_hermes_distribution_patch as patch_module


UNPATCHED_TEMPLATE = '''
DEFAULT_DIST_OWNED: Tuple[str, ...] = (
    "SOUL.md",
)

# Paths that are NEVER part of a distribution. These are user-owned and are
USER_OWNED_EXCLUDE: frozenset = frozenset({
    "auth.json",
})


def _git_clone(url: str, dest: Path) -> None:
    pass


def _stage_source(source: str, workdir: Path) -> Tuple[Path, str]:
    src_str = source.strip()
    if _looks_like_git_url(src_str):
        cloned = workdir / "clone"
        _git_clone(src_str, cloned)
        # Remove .git to keep the staged tree clean
        shutil.rmtree(cloned / ".git", ignore_errors=True)
        return cloned, src_str
    path_guess = Path(source)
    if path_guess.is_dir():
        return path_guess.resolve(), str(path_guess.resolve())
    raise DistributionError("bad")


def _copy_dist_payload(staged, target, manifest, preserve_config) -> None:
    for entry in staged.iterdir():
        name = entry.name
        if name in USER_OWNED_EXCLUDE:
            continue
        dest = target / name
        if entry.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            staged_resolved = staged.resolve()
            shutil.copytree(
                entry,
                dest,
                ignore=lambda d, names: (
                    [n for n in names if n in USER_OWNED_EXCLUDE]
                    if Path(d).resolve() == staged_resolved
                    else []
                ),
            )
    write_manifest(target, manifest)
'''


class HermesDistributionPatchTests(unittest.TestCase):
    def test_apply_patch_is_idempotent(self):
        patched, changes = patch_module.apply_patch(UNPATCHED_TEMPLATE)
        self.assertTrue(patch_module.is_patched(patched))
        self.assertIn("staging_exclude", changes)
        again, more = patch_module.apply_patch(patched)
        self.assertEqual(again, patched)
        self.assertEqual(more, [])

    def test_ensure_patch_dry_run_reports_would_patch(self):
        original = patch_module.find_profile_distribution_py
        try:
            patch_module.find_profile_distribution_py = lambda: Path("missing.py")
            with self.assertRaises(FileNotFoundError):
                patch_module.ensure_patch(dry_run=True)
        finally:
            patch_module.find_profile_distribution_py = original

    def test_live_hermes_install_is_patched_or_patchable(self):
        try:
            target = patch_module.find_profile_distribution_py()
        except FileNotFoundError:
            self.skipTest("Hermes not installed")
        text = target.read_text(encoding="utf-8")
        if patch_module.is_patched(text):
            return
        patched, changes = patch_module.apply_patch(text)
        self.assertTrue(patch_module.is_patched(patched))
        self.assertTrue(changes)


if __name__ == "__main__":
    unittest.main()
