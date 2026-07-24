import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  let content = fs.readFileSync(envPath, "utf8");
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  const parsed = dotenv.parse(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function envValue(name, fallback = "") {
  const raw = process.env[name];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  return String(raw).trim().replace(/^['"]|['"]$/g, "");
}

export function loadCredential(name, fileEnvName) {
  const inline = envValue(name);
  if (inline) {
    return inline;
  }
  const filePath = envValue(fileEnvName);
  if (!filePath) {
    return "";
  }
  const resolved = path.resolve(filePath);
  let content = fs.readFileSync(resolved, "utf8");
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return content.trim().replace(/^['"]|['"]$/g, "");
}
