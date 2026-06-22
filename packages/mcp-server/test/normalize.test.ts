import { describe, expect, it } from "vitest";
import {
  NormalizationError,
  normalizePreviewUrl,
  normalizeReviewRequest,
  requestFingerprint,
} from "../src/index.js";

describe("normalizePreviewUrl (TRD §4.1)", () => {
  it("accepts a plain https URL unchanged", () => {
    expect(normalizePreviewUrl("https://preview.example.com/pricing")).toBe(
      "https://preview.example.com/pricing",
    );
  });

  it("strips the fragment", () => {
    expect(normalizePreviewUrl("https://preview.example.com/pricing#cta")).toBe(
      "https://preview.example.com/pricing",
    );
  });

  it("preserves the query string", () => {
    expect(normalizePreviewUrl("https://preview.example.com/p?variant=b")).toBe(
      "https://preview.example.com/p?variant=b",
    );
  });

  it("rejects http", () => {
    expect(() => normalizePreviewUrl("http://preview.example.com")).toThrow(NormalizationError);
  });

  it("rejects credentials in the URL", () => {
    expect(() => normalizePreviewUrl("https://user:pass@preview.example.com")).toThrow(
      NormalizationError,
    );
  });

  it("rejects a non-absolute URL", () => {
    expect(() => normalizePreviewUrl("/pricing")).toThrow(NormalizationError);
  });
});

describe("normalizeReviewRequest (TRD §4.1)", () => {
  const base = { url: "https://preview.example.com/", client_request_id: "req-12345678" };

  it("applies default routes, viewports, depth, and response mode", () => {
    const req = normalizeReviewRequest(base);
    expect(req.routes).toEqual(["/"]);
    expect(req.viewports).toEqual(["mobile", "desktop"]);
    expect(req.depth).toBe("deep");
    expect(req.response_mode).toBe("compact");
    expect(req.expected_revision).toBeNull();
  });

  it("dedupes routes and viewports while preserving order", () => {
    const req = normalizeReviewRequest({
      ...base,
      routes: ["/a", "/a", "/b"],
      viewports: ["desktop", "desktop", "mobile"],
    });
    expect(req.routes).toEqual(["/a", "/b"]);
    expect(req.viewports).toEqual(["desktop", "mobile"]);
  });

  it("rejects routes that are not root-relative", () => {
    expect(() => normalizeReviewRequest({ ...base, routes: ["pricing"] })).toThrow(
      NormalizationError,
    );
  });

  it("rejects more than 5 routes", () => {
    expect(() =>
      normalizeReviewRequest({ ...base, routes: ["/a", "/b", "/c", "/d", "/e", "/f"] }),
    ).toThrow(NormalizationError);
  });

  it("produces a fingerprint independent of the idempotency key", () => {
    const a = normalizeReviewRequest({ ...base, client_request_id: "key-aaaaaaaa" });
    const b = normalizeReviewRequest({ ...base, client_request_id: "key-bbbbbbbb" });
    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
  });

  it("produces different fingerprints for different normalized arguments", () => {
    const a = normalizeReviewRequest(base);
    const b = normalizeReviewRequest({ ...base, depth: "triage" });
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });
});
