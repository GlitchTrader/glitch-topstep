import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeProjectXError } from "./errors.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const sessionPath = path.join(root, "data", "projectx-session.json");

export class ProjectXClient {
  constructor(options) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.username = options.username;
    this.apiKey = options.apiKey;
    this.token = null;
    this.tokenUpdatedAt = 0;
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.username && this.apiKey);
  }

  get connected() {
    return Boolean(this.token);
  }

  loadCachedSession() {
    try {
      if (!fs.existsSync(sessionPath)) {
        return;
      }
      const cached = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      if (cached?.token && cached?.username === this.username) {
        this.token = cached.token;
        this.tokenUpdatedAt = cached.updatedAt || Date.now();
      }
    } catch {
      // ignore corrupt cache
    }
  }

  persistSession() {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      JSON.stringify(
        {
          username: this.username,
          token: this.token,
          updatedAt: this.tokenUpdatedAt,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  clearSession() {
    this.token = null;
    this.tokenUpdatedAt = 0;
    try {
      fs.unlinkSync(sessionPath);
    } catch {
      // ignore
    }
  }

  async login() {
    const body = await this.post(
      "/api/Auth/loginKey",
      {
        userName: this.username,
        apiKey: this.apiKey,
      },
      { authenticated: false },
    );
    if (!body?.success || !body?.token) {
      throw new Error(describeProjectXError(body, "ProjectX loginKey failed"));
    }
    this.token = body.token;
    this.tokenUpdatedAt = Date.now();
    this.lastError = null;
    this.persistSession();
    return body.token;
  }

  async validate() {
    if (!this.token) {
      return this.login();
    }
    const body = await this.post("/api/Auth/validate", {}, { authenticated: true });
    if (body?.success && body?.newToken) {
      this.token = body.newToken;
      this.tokenUpdatedAt = Date.now();
      this.persistSession();
    } else if (!body?.success) {
      return this.login();
    }
    return this.token;
  }

  async ensureSession() {
    if (!this.configured) {
      throw new Error("ProjectX credentials are not configured");
    }
    this.loadCachedSession();
    const ageMs = Date.now() - this.tokenUpdatedAt;
    if (!this.token || ageMs > 23 * 60 * 60 * 1000) {
      await this.login();
      return this.token;
    }
    try {
      await this.validate();
      return this.token;
    } catch (error) {
      await this.login();
      return this.token;
    }
  }

  async post(pathname, payload = {}, options = {}) {
    const authenticated = options.authenticated !== false;
    const url = `${this.apiUrl}${pathname}`;
    const headers = {
      accept: "text/plain",
      "Content-Type": "application/json",
    };
    if (authenticated && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const message = body?.errorMessage || body?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.body = body;
      this.lastError = message;
      throw error;
    }
    if (body?.success === false) {
      const message = describeProjectXError(body);
      const error = new Error(message);
      error.status = 400;
      error.body = body;
      this.lastError = message;
      throw error;
    }
    return body;
  }

  async searchAccounts(onlyActiveAccounts = true) {
    await this.ensureSession();
    const body = await this.post("/api/Account/search", { onlyActiveAccounts });
    return body.accounts || [];
  }

  async listContracts(live = false) {
    await this.ensureSession();
    const body = await this.post("/api/Contract/available", { live });
    return body.contracts || [];
  }

  async searchOpenPositions(accountId) {
    await this.ensureSession();
    const body = await this.post("/api/Position/searchOpen", { accountId });
    return body.positions || [];
  }

  async searchOpenOrders(accountId) {
    await this.ensureSession();
    const body = await this.post("/api/Order/searchOpen", { accountId });
    return body.orders || [];
  }

  async retrieveBars({
    contractId,
    live = false,
    startTime,
    endTime,
    unit = 2,
    unitNumber = 1,
    limit = 120,
    includePartialBar = true,
  }) {
    await this.ensureSession();
    const body = await this.post("/api/History/retrieveBars", {
      contractId,
      live,
      startTime,
      endTime,
      unit,
      unitNumber,
      limit,
      includePartialBar,
    });
    return body.bars || [];
  }

  async placeOrder(order) {
    await this.ensureSession();
    return this.post("/api/Order/place", order);
  }

  async closePosition(accountId, contractId) {
    await this.ensureSession();
    return this.post("/api/Position/closeContract", { accountId, contractId });
  }

  async modifyOrder(accountId, orderId, fields) {
    await this.ensureSession();
    return this.post("/api/Order/modify", {
      accountId,
      orderId,
      ...fields,
    });
  }

  async cancelOrder(accountId, orderId) {
    await this.ensureSession();
    return this.post("/api/Order/cancel", { accountId, orderId });
  }

  async searchOrders(accountId, startTimestamp, endTimestamp = null) {
    await this.ensureSession();
    const payload = { accountId, startTimestamp };
    if (endTimestamp) {
      payload.endTimestamp = endTimestamp;
    }
    const body = await this.post("/api/Order/search", payload);
    return body.orders || [];
  }

  async searchTrades(accountId, startTimestamp, endTimestamp = null) {
    await this.ensureSession();
    const payload = { accountId, startTimestamp };
    if (endTimestamp) {
      payload.endTimestamp = endTimestamp;
    }
    const body = await this.post("/api/Trade/search", payload);
    return body.trades || [];
  }
}
