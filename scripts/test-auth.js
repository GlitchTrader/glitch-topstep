import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { loadEnvFile } from "../src/env.js";
import { describeProjectXError } from "../src/projectx/errors.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnvFile(path.join(root, ".env"));

const user = config.projectXUsername;
const key = config.projectXApiKey;

if (!user || !key) {
  console.error("Set PROJECT_X_USERNAME and PROJECT_X_API_KEY in .env");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      username_length: user.length,
      username_has_at: user.includes("@"),
      api_key_length: key.length,
      api_key_ends_with_equals: key.endsWith("="),
      api_key_has_whitespace: /\s/.test(key),
      api_url: config.projectXApiUrl,
      note: "Trailing = in API keys is normal base64 padding and is sent correctly.",
    },
    null,
    2,
  ),
);

const response = await fetch(`${config.projectXApiUrl}/api/Auth/loginKey`, {
  method: "POST",
  headers: { accept: "text/plain", "Content-Type": "application/json" },
  body: JSON.stringify({ userName: user, apiKey: key }),
});
const body = await response.json();

if (!body?.success) {
  console.error(describeProjectXError(body));
  console.error(
    JSON.stringify(
      {
        checklist: [
          "Use the TopstepX login username shown in Settings -> API (not your email).",
          "Regenerate the API key in TopstepX and paste the new value immediately.",
          "Complete ProjectX Linking and buy the API subscription on dashboard.projectx.com.",
          "If the key ends with =, leave it unquoted in .env or use PROJECT_X_API_KEY_FILE.",
        ],
        errorCode: body?.errorCode ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      success: true,
      token_received: Boolean(body.token),
      message: "ProjectX authentication succeeded.",
    },
    null,
    2,
  ),
);
