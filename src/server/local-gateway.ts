import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { ExecutionCoordinator, ExecutionReceipt } from "../execution/coordinator.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";

const MAX_BODY_BYTES = 65_536;

export interface LocalGatewayOptions {
  host: string;
  port: number;
  token: string;
}

export class LocalGatewayServer {
  private server: Server | null = null;

  public constructor(
    private readonly options: LocalGatewayOptions,
    private readonly health: () => Record<string, unknown>,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly packet: () => DirectDecisionPacket,
    private readonly coordinator: ExecutionCoordinator,
  ) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.host, () => resolve());
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${this.options.host}:${this.options.port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        this.json(response, 200, this.health());
        return;
      }
      if (!this.authorized(request)) {
        this.json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        this.json(response, 200, this.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/packet") {
        this.json(response, 200, this.packet());
        return;
      }
      if (request.method === "POST" && url.pathname === "/intent") {
        const body = await this.readJsonBody(request);
        const receipt: ExecutionReceipt = await this.coordinator.handleWireIntent(body);
        const status = receipt.status === "rejected" ? 422 : 202;
        this.json(response, status, receipt);
        return;
      }
      this.json(response, 404, { error: "not_found" });
    } catch (error) {
      const code = error instanceof PayloadTooLargeError ? 413 : 500;
      this.json(response, code, {
        error: error instanceof PayloadTooLargeError ? "payload_too_large" : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return false;
    }
    const provided = Buffer.from(header.slice("Bearer ".length).trim());
    const expected = Buffer.from(this.options.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        throw new PayloadTooLargeError();
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text);
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value));
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", payload.length);
    response.end(payload);
  }
}

class PayloadTooLargeError extends Error {
  public constructor() {
    super("request body exceeds 65536 bytes");
  }
}
