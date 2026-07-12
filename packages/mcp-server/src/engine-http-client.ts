import { createHmac, randomUUID } from "node:crypto";
import type { EngineReviewResult } from "@apature/mcp-types";
import type { NormalizedReviewRequest } from "./normalize.js";
import type { EngineJobClient, EngineJobPoll } from "./engine-client.js";

const INSTALLATION_HEADER = "x-gate-installation";
const TIMESTAMP_HEADER = "x-gate-timestamp";
const SIGNATURE_HEADER = "x-gate-signature";

export interface EngineHttpClientOptions {
  baseUrl: string;
  hmacSecret: string;
  schemaVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class EngineDependencyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EngineDependencyError";
  }
}

/** Signed async client for Judgment Engine's POST/GET/DELETE /jobs contract. */
export class JudgmentEngineHttpClient implements EngineJobClient {
  private readonly fetchImpl: typeof fetch;
  private readonly expectedSchema: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: EngineHttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    // Judgment Engine's current wire contract is schema "1". MCP Review's own
    // public result envelope is independently versioned as "1.0.0".
    this.expectedSchema = options.schemaVersion ?? "1";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ready(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(new URL("/readyz", this.options.baseUrl), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async submit(
    installationId: string,
    idempotencyKey: string,
    request: NormalizedReviewRequest,
    correlationId = `cor_${randomUUID()}`,
  ): Promise<string> {
    const body = JSON.stringify({ idempotencyKey, depth: request.depth, request });
    const response = await this.request("POST", "/jobs", installationId, body, correlationId);
    if (response.status !== 202 && response.status !== 409) {
      throw await this.error(response, "engine submission failed");
    }
    const payload = (await response.json()) as { jobId?: unknown };
    if (typeof payload.jobId !== "string" || payload.jobId.length === 0) {
      throw new EngineDependencyError("engine submission omitted jobId", response.status);
    }
    return payload.jobId;
  }

  async get(installationId: string, jobId: string, correlationId = `cor_${randomUUID()}`): Promise<EngineJobPoll> {
    const response = await this.request("GET", `/jobs/${encodeURIComponent(jobId)}`, installationId, "", correlationId);
    if (response.status !== 200) throw await this.error(response, "engine poll failed");
    const schemaVersion = response.headers.get("x-schema-version") ?? "";
    if (schemaVersion !== this.expectedSchema) {
      throw new EngineDependencyError(
        `unsupported engine result schema ${schemaVersion || "<missing>"}; expected ${this.expectedSchema}`,
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const state = payload.state;
    if (state === "completed") {
      if (!payload.result || typeof payload.result !== "object") {
        throw new EngineDependencyError("completed engine job omitted result");
      }
      return { jobId, state, result: payload.result as EngineReviewResult, schemaVersion };
    }
    if (state === "failed") {
      return { jobId, state, error: String(payload.error ?? "engine job failed"), schemaVersion };
    }
    if (state === "pending" || state === "running" || state === "cancelling") return { jobId, state };
    throw new EngineDependencyError(`unknown engine job state ${String(state)}`);
  }

  async cancel(installationId: string, jobId: string, correlationId = `cor_${randomUUID()}`): Promise<boolean> {
    const response = await this.request("DELETE", `/jobs/${encodeURIComponent(jobId)}`, installationId, "", correlationId);
    if (response.status === 404) return false;
    if (response.status !== 200) throw await this.error(response, "engine cancellation failed");
    const payload = (await response.json()) as { cancelling?: unknown };
    return payload.cancelling === true;
  }

  private async request(method: string, path: string, installationId: string, body: string, correlationId: string): Promise<Response> {
    let last: Response | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const timestamp = String(this.now());
      const signature = createHmac("sha256", this.options.hmacSecret)
        .update(`${timestamp}.${installationId}.${body}`)
        .digest("hex");
      const response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          "content-type": "application/json",
          [INSTALLATION_HEADER]: installationId,
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: `sha256=${signature}`,
          "x-correlation-id": correlationId,
          traceparent: correlationId,
        },
        body: method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      last = response;
      if ((response.status !== 429 && response.status !== 503) || attempt === this.maxRetries) return response;
      await this.sleep(retryAfterMs(response.headers.get("retry-after"), attempt));
    }
    return last!;
  }

  private async error(response: Response, fallback: string): Promise<EngineDependencyError> {
    const retry = retryAfterMs(response.headers.get("retry-after"), 0);
    const text = await response.text().catch(() => "");
    return new EngineDependencyError(text || fallback, response.status, retry);
  }
}

function retryAfterMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}
