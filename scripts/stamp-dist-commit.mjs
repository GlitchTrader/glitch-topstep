import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error(`dist_commit_stamp_invalid:${sha}`);
}
writeFileSync(new URL("../dist/BUILD_COMMIT", import.meta.url), `${sha}\n`);
