import { readFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { StoredProviderEvidenceEvent, ProviderEvidenceSource } from "../domain/provider-evidence.js";
import type { ExecutionCoordinator, ExecutionReceipt } from "../execution/coordinator.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";
import type { OutcomeRevisionPage } from "../storage/sqlite-outcome-feed.js";
import { ProjectXOrderOwnershipService } from "../ownership/projectx-order-ownership.js";

const EVIDENCE_SOURCES = new Set<ProviderEvidenceSource>([
  "projectx_rest",
  "projectx_user_stream",
  "projectx_market_stream",
  "projectx_lifecycle",
]);
const MAX_BODY_BYTES = 65_536;
const DEFAULT_EVIDENCE_LIMIT = 100;
const MAX_EVIDENCE_LIMIT = 1_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function isLoopbackGatewayHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface LocalGatewayOptions {
  host: string;
  port: number;
  token: string;
  operatorToken?: string;
  ownership?: {
    executionDatabasePath: string;
    evidenceDatabasePath: string;
    accountId: number;
    accountName: string;
    contractId: string;
    instrument: string;
  };
}

export interface PacketRequest {
  contractId?: string;
  instrument?: string;
}

export class LocalGatewayServer {
  private server: Server | null = null;
  private ownershipService: ProjectXOrderOwnershipService | null;
  private readonly ownsOwnershipService: boolean;

  public constructor(
    private readonly options: LocalGatewayOptions,
    private readonly health: () => Record<string, unknown>,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly packet: (request?: PacketRequest) => DirectDecisionPacket | Promise<DirectDecisionPacket>,
    private readonly evidence: (
      limit: number,
      query?: { source?: ProviderEvidenceSource; eventType?: string },
    ) => StoredProviderEvidenceEvent[],
    private readonly coordinator: ExecutionCoordinator,
    ownershipService: ProjectXOrderOwnershipService | null = null,
    private readonly outcomes: (limit: number) => Promise<TradeOutcomeV1[]> = async () => [],
    private readonly acceptanceStreamGap?: () => Promise<{ phases: unknown[] }>,
    private readonly outcomeFeed?: (afterSequence: number, limit: number) => OutcomeRevisionPage,
    private readonly control?: (input: unknown) => Promise<unknown>,
    private readonly controlLookup?: (controlId: string) => unknown,
    private readonly scanner?: () => unknown,
    private readonly executionFacts?: (afterSequence: number, limit: number) => unknown,
  ) {
    const ownership = options.ownership;
    this.ownsOwnershipService = ownershipService === null && ownership !== undefined;
    this.ownershipService = ownershipService
      ?? (ownership
        ? new ProjectXOrderOwnershipService(
            ownership.executionDatabasePath,
            ownership.evidenceDatabasePath,
            {
              accountId: ownership.accountId,
              accountName: ownership.accountName,
              contractId: ownership.contractId,
              instrument: ownership.instrument,
            },
          )
        : null);
  }

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
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (this.ownsOwnershipService) {
      this.ownershipService?.close();
    }
    this.ownershipService = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${this.options.host}:${this.options.port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        this.json(response, 200, this.health());
        return;
      }
      if (request.method === "GET" && url.pathname === "/console") {
        if (!isLoopbackGatewayHost(this.options.host)) {
          this.json(response, 403, { error: "console_loopback_only" });
          return;
        }
        this.html(response, 200, readConsoleHtml());
        return;
      }
      const operatorRoute = url.pathname === "/control"
        && (request.method === "GET" || request.method === "POST");
      if (operatorRoute) {
        if (!this.operatorAuthorized(request)) {
          this.json(response, 403, { error: "operator_authorization_required" });
          return;
        }
      } else if (!this.authorized(request)) {
        this.json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        this.json(response, 200, this.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/packet") {
        const contractId = url.searchParams.get("contract_id")?.trim() || undefined;
        const instrument = url.searchParams.get("instrument")?.trim() || undefined;
        this.json(response, 200, await Promise.resolve(this.packet({ contractId, instrument })));
        return;
      }
      if (request.method === "GET" && url.pathname === "/evidence") {
        const source = this.evidenceSource(url.searchParams.get("source"));
        const eventType = url.searchParams.get("event_type")?.trim() || undefined;
        const events = this.evidence(this.evidenceLimit(url.searchParams.get("limit")), {
          source,
          eventType,
        });
        this.json(response, 200, {
          schema_version: "glitch.projectx.evidence_page.v1",
          recorded_utc: new Date().toISOString(),
          count: events.length,
          events,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ownership") {
        if (!this.ownershipService) {
          this.json(response, 503, { error: "ownership_projection_unavailable" });
          return;
        }
        this.json(response, 200, this.ownershipService.current(this.snapshot().instrumentOpenContracts));
        return;
      }
      if (request.method === "GET" && url.pathname === "/outcomes") {
        const outcomes = await this.outcomes(this.outcomeLimit(url.searchParams.get("limit")));
        this.json(response, 200, {
          schema_version: "glitch.topstep.trade_outcomes_page.v1",
          recorded_utc: new Date().toISOString(),
          count: outcomes.length,
          outcomes,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/scanner") {
        if (!this.scanner) {
          this.json(response, 503, { error: "scanner_unavailable" });
          return;
        }
        this.json(response, 200, this.scanner());
        return;
      }
      if (request.method === "GET" && url.pathname === "/outcomes/feed") {
        if (!this.outcomeFeed) {
          this.json(response, 503, { error: "outcome_feed_unavailable" });
          return;
        }
        const afterSequence = this.nonNegativeInteger(url.searchParams.get("after_sequence"), 0);
        const limit = this.evidenceLimit(url.searchParams.get("limit"));
        this.json(response, 200, this.outcomeFeed(afterSequence, limit));
        return;
      }
      if (request.method === "GET" && url.pathname === "/execution/facts") {
        if (!this.executionFacts) {
          this.json(response, 503, { error: "execution_facts_unavailable" });
          return;
        }
        const afterSequence = this.nonNegativeInteger(url.searchParams.get("after_sequence"), 0);
        const limit = this.evidenceLimit(url.searchParams.get("limit"));
        this.json(response, 200, this.executionFacts(afterSequence, limit));
        return;
      }
      if (request.method === "GET" && url.pathname === "/intent/status") {
        const intentId = url.searchParams.get("intent_id")?.trim();
        if (!intentId) {
          this.json(response, 400, { error: "intent_id_required" });
          return;
        }
        this.json(response, 200, this.coordinator.intentDeliveryStatus(intentId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/intent/receipt") {
        const intentId = url.searchParams.get("intent_id")?.trim();
        if (!intentId) {
          this.json(response, 400, { error: "intent_id_required" });
          return;
        }
        const receipt = this.coordinator.receiptForIntent(intentId);
        if (!receipt) {
          this.json(response, 404, { error: "intent_receipt_not_found" });
          return;
        }
        this.json(response, 200, receipt);
        return;
      }
      if (request.method === "POST" && url.pathname === "/intent") {
        const body = await this.readJsonBody(request);
        const receipt: ExecutionReceipt = await this.coordinator.handleWireIntent(body);
        const status = receipt.status === "rejected"
          ? 422
          : receipt.status === "ambiguous"
            ? 503
            : 202;
        this.json(response, status, receipt);
        return;
      }
      if (request.method === "POST" && url.pathname === "/control") {
        if (!this.control) {
          this.json(response, 503, { error: "control_plane_unavailable" });
          return;
        }
        if (!this.operatorAuthorized(request)) {
          this.json(response, 403, { error: "operator_authorization_required" });
          return;
        }
        const body = await this.readJsonBody(request);
        const operatorCommand = typeof body === "object" && body !== null && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), issuer: "local_operator" }
          : body;
        this.json(response, 202, await this.control(operatorCommand));
        return;
      }
      if (request.method === "GET" && url.pathname === "/control") {
        if (!this.operatorAuthorized(request)) {
          this.json(response, 403, { error: "operator_authorization_required" });
          return;
        }
        const controlId = url.searchParams.get("control_id")?.trim();
        if (!controlId) {
          this.json(response, 400, { error: "control_id_required" });
          return;
        }
        const result = this.controlLookup?.(controlId) ?? null;
        this.json(response, result === null ? 404 : 200, result ?? { error: "control_not_found" });
        return;
      }
      if (
        process.env.GLITCH_ACCEPTANCE_STREAM_GAP === "1"
        && request.method === "POST"
        && url.pathname === "/acceptance/force-stream-gap"
      ) {
        if (!this.acceptanceStreamGap) {
          this.json(response, 503, { error: "acceptance_stream_gap_unavailable" });
          return;
        }
        const result = await this.acceptanceStreamGap();
        this.json(response, 200, result);
        return;
      }
      this.json(response, 404, { error: "not_found" });
    } catch (error) {
      const correlationId = randomUUID();
      console.error("gateway_request_failed", { correlationId, error });
      const code = error instanceof PayloadTooLargeError
        ? 413
        : error instanceof InvalidQueryError
          ? 400
          : 500;
      this.json(response, code, {
        error: error instanceof PayloadTooLargeError
          ? "payload_too_large"
          : error instanceof InvalidQueryError
            ? "invalid_query"
            : "internal_error",
        correlation_id: correlationId,
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

  private evidenceSource(raw: string | null): ProviderEvidenceSource | undefined {
    if (raw === null || raw.length === 0) {
      return undefined;
    }
    if (!EVIDENCE_SOURCES.has(raw as ProviderEvidenceSource)) {
      throw new InvalidQueryError(
        `source must be one of ${[...EVIDENCE_SOURCES].join(",")}`,
      );
    }
    return raw as ProviderEvidenceSource;
  }

  private evidenceLimit(raw: string | null): number {
    if (raw === null || raw.length === 0) {
      return DEFAULT_EVIDENCE_LIMIT;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_EVIDENCE_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer between 1 and ${MAX_EVIDENCE_LIMIT}`);
    }
    return value;
  }

  private outcomeLimit(raw: string | null): number {
    return this.evidenceLimit(raw);
  }

  private operatorAuthorized(request: IncomingMessage): boolean {
    const token = this.options.operatorToken;
    if (!token) {
      return false;
    }
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return false;
    }
    const provided = Buffer.from(header.slice("Bearer ".length).trim());
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private nonNegativeInteger(raw: string | null, fallback: number): number {
    if (raw === null || raw.length === 0) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new InvalidQueryError("value must be a non-negative integer");
    }
    return value;
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value));
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", payload.length);
    response.end(payload);
  }

  private html(response: ServerResponse, status: number, body: string): void {
    const payload = Buffer.from(body, "utf8");
    response.statusCode = status;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", payload.length);
    response.end(payload);
  }
}

class PayloadTooLargeError extends Error {
  public constructor() {
    super("request body exceeds 65536 bytes");
  }
}

class InvalidQueryError extends Error {}

function readConsoleHtml(): string {
  return readFileSync(join(process.cwd(), "console", "index.html"), "utf8");
}
