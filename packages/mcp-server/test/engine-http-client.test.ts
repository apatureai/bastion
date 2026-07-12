import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EngineDependencyError, JudgmentEngineHttpClient } from "../src/index.js";

const request = {
  url: "https://preview.example.com/",
  routes: ["/"],
  viewports: ["desktop" as const],
  depth: "deep" as const,
  expected_revision: null,
  response_mode: "compact" as const,
  client_request_id: "engine-0001",
};

describe("JudgmentEngineHttpClient (#36)", () => {
  it("signs the exact body, propagates correlation, and accepts duplicate 409", async () => {
    const calls: RequestInit[] = [];
    const client = new JudgmentEngineHttpClient({
      baseUrl: "https://engine.example",
      hmacSecret: "secret",
      now: () => 1234,
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({ jobId: "eng_1" }), { status: 409 });
      },
    });
    await expect(client.submit("tenant-a", "idem-1", request, "trace-1")).resolves.toBe("eng_1");
    const headers = new Headers(calls[0]!.headers);
    const body = String(calls[0]!.body);
    const expected = createHmac("sha256", "secret").update(`1234.tenant-a.${body}`).digest("hex");
    expect(headers.get("x-gate-signature")).toBe(`sha256=${expected}`);
    expect(headers.get("x-correlation-id")).toBe("trace-1");
  });

  it("honors Retry-After for 429/503 with bounded retries", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new JudgmentEngineHttpClient({
      baseUrl: "https://engine.example",
      hmacSecret: "secret",
      maxRetries: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => {
        calls++;
        if (calls < 3) return new Response("busy", { status: calls === 1 ? 429 : 503, headers: { "retry-after": "2" } });
        return new Response(JSON.stringify({ jobId: "eng_2" }), { status: 202 });
      },
    });
    await expect(client.submit("tenant-a", "idem-2", request)).resolves.toBe("eng_2");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("fails closed on a mismatched result schema", async () => {
    const client = new JudgmentEngineHttpClient({
      baseUrl: "https://engine.example",
      hmacSecret: "secret",
      fetch: async () => new Response(JSON.stringify({ jobId: "eng_3", state: "running" }), {
        status: 200,
        headers: { "x-schema-version": "2.0.0" },
      }),
    });
    await expect(client.get("tenant-a", "eng_3")).rejects.toBeInstanceOf(EngineDependencyError);
  });
});
