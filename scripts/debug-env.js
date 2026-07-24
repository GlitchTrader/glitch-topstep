import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

const raw = fs.readFileSync(".env", "utf8");
const keyLine = raw.split(/\r?\n/).find((line) => line.startsWith("PROJECT_X_API_KEY=")) || "";
const user = process.env.PROJECT_X_USERNAME || "";
const key = process.env.PROJECT_X_API_KEY || "";

console.log(
  JSON.stringify(
    {
      env_file_has_bom: raw.charCodeAt(0) === 0xfeff,
      key_line_quoted: /^PROJECT_X_API_KEY=["']/.test(keyLine),
      username_length: user.length,
      username_has_at: user.includes("@"),
      username_has_space: /\s/.test(user),
      key_length: key.length,
      key_ends_with_equals: key.endsWith("="),
      key_has_space: /\s/.test(key),
      key_tail_char_codes: [...key.slice(-4)].map((char) => char.charCodeAt(0)),
    },
    null,
    2,
  ),
);

const response = await fetch("https://api.topstepx.com/api/Auth/loginKey", {
  method: "POST",
  headers: { accept: "text/plain", "Content-Type": "application/json" },
  body: JSON.stringify({ userName: user, apiKey: key }),
});
const body = await response.json();
console.log(
  JSON.stringify(
    {
      http_status: response.status,
      success: body.success,
      errorCode: body.errorCode,
      has_token: Boolean(body.token),
    },
    null,
    2,
  ),
);
