import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJsonSha256(value) {
  return sha256Hex(JSON.stringify(value));
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name}`);
  return process.argv[index + 1];
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockBytes = readFileSync(new URL("../package-lock.json", import.meta.url));
const profileRoot = process.argv.includes("--profile-root") ? resolve(argument("profile-root")) : null;
const profileCommit = profileRoot
  ? execFileSync("git", ["-c", `safe.directory=${profileRoot}`, "-C", profileRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  : argument("profile-commit");
const profileVersion = profileRoot
  ? /version:\s*["']?([^"'\s]+)/.exec(readFileSync(`${profileRoot}/distribution.yaml`, "utf8"))?.[1]
  : argument("profile-version");
const profileManifest = profileRoot ? readFileSync(`${profileRoot}/SHA256SUMS`) : null;
const promptVersion = profileRoot
  ? JSON.parse(readFileSync(`${profileRoot}/paired-contract.json`, "utf8")).profile.prompt_version
  : argument("prompt-version");
if (!profileVersion || !promptVersion) throw new Error("profile_metadata_missing");
const gatewayPairedContractPath = new URL("../release/paired-contract.json", import.meta.url);
const gatewayPairedContractBytes = readFileSync(gatewayPairedContractPath);
const profilePairedContractBytes = profileRoot
  ? readFileSync(`${profileRoot}/paired-contract.json`)
  : null;
const pairDigest = canonicalJsonSha256({
  gateway_commit: argument("gateway-commit"),
  profile_commit: profileCommit,
  gateway_paired_contract_sha256: sha256Hex(gatewayPairedContractBytes),
  profile_paired_contract_sha256: profilePairedContractBytes
    ? sha256Hex(profilePairedContractBytes)
    : argument("profile-paired-contract-sha256"),
});
const manifest = {
  schema_version: "glitch.topstep.paired_release.v1",
  created_utc: new Date().toISOString(),
  immutable: true,
  armed_promotion_requires_human_approval: true,
  pair_digest: pairDigest,
  gateway: {
    repository: "GlitchTrader/glitch-topstep",
    commit: argument("gateway-commit"),
    version: packageJson.version,
    package_lock_sha256: createHash("sha256").update(lockBytes).digest("hex"),
  },
  profile: {
    repository: "GlitchTrader/glitch-topstep-hermes-profile",
    commit: profileCommit,
    version: profileVersion,
    sha256sums_sha256: createHash("sha256").update(profileManifest ?? argument("profile-manifest-sha256")).digest("hex"),
    prompt_version: promptVersion,
  },
  validation: {
    prac_or_shadow_evidence_ref: argument("evidence-ref"),
    partial_exit_provider_acceptance: "proven_prac_short_long_with_saga",
    gateway_paired_contract_sha256: sha256Hex(gatewayPairedContractBytes),
  },
};
writeFileSync(argument("output"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
