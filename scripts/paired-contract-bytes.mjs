import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function pairedContractSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertPairedContractsByteIdentical(gatewayPath, profilePath) {
  const gatewayBytes = readFileSync(gatewayPath);
  const profileBytes = readFileSync(profilePath);
  if (Buffer.compare(gatewayBytes, profileBytes) !== 0) {
    throw new Error(
      `paired_contract_byte_mismatch gateway=${pairedContractSha256(gatewayBytes)} profile=${pairedContractSha256(profileBytes)}`,
    );
  }
  return {
    gateway_paired_contract_sha256: pairedContractSha256(gatewayBytes),
    profile_paired_contract_sha256: pairedContractSha256(profileBytes),
  };
}
