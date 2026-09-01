import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from distribution_manifest import (  # noqa: E402
    read_distribution_version,
    verify_sha256sums,
)


class Sha256sumsTests(unittest.TestCase):
    def test_manifest_matches_files(self):
        self.assertEqual(verify_sha256sums(ROOT), [])

    def test_distribution_version_readable(self):
        version = read_distribution_version(ROOT)
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
