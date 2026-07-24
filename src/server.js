import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import * as gateway from "./gateway/service.js";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res) {
  sendJson(res, 401, { error: "unauthorized", message: "Bearer token required" });
}

function requireAuth(req, res) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1].trim() !== config.localToken) {
    unauthorized(res);
    return false;
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, gateway.getHealth());
    return;
  }

  if (!requireAuth(req, res)) {
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/state") {
      sendJson(res, 200, await gateway.buildState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/packet") {
      if (gateway.usesProjectX() && !gateway.getHealth().projectx_connected) {
        sendJson(res, 503, {
          error: "projectx_unavailable",
          message: gateway.getHealth().projectx_error || "ProjectX is not connected",
        });
        return;
      }
      sendJson(res, 200, await gateway.buildPacket());
      return;
    }

    if (req.method === "POST" && url.pathname === "/intent") {
      const intent = await readJsonBody(req);
      const packet = await gateway.buildPacket();
      const result = await gateway.handleIntent(intent, packet);
      sendJson(res, config.tradingMode === "armed" ? 202 : 200, result);
      return;
    }

    sendJson(res, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    sendJson(res, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

await gateway.initialize();

server.listen(config.port, config.host, () => {
  const fingerprint = crypto
    .createHash("sha256")
    .update(config.localToken)
    .digest("hex")
    .slice(0, 12);
  console.log(
    `[glitch-topstep] listening on http://${config.host}:${config.port} mode=${config.tradingMode} token#${fingerprint}`,
  );
});
