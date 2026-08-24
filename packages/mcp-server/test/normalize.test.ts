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

  it("rejects http on a remote host", () => {
    expect(() => normalizePreviewUrl("http://preview.example.com")).toThrow(NormalizationError);
  });

  it("allows plain http to a loopback dev host, preserving the port and path", () => {
    expect(normalizePreviewUrl("http://localhost:3000/pricing")).toBe("http://localhost:3000/pricing");
    expect(normalizePreviewUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
    expect(normalizePreviewUrl("http://[::1]:5173/app")).toBe("http://[::1]:5173/app");
  });

  it("does not extend the http exception to a non-loopback private host", () => {
    // 10.x is private, not loopback: it stays https-only.
    expect(() => normalizePreviewUrl("http://10.0.0.5/")).toThrow(NormalizationError);
  });

  it("rejects credentials in the URL", () => {
    expect(() => normalizePreviewUrl("https://user:pass@preview.example.com")).toThrow(
      NormalizationError,
    );
  });

  it("tags URL-policy violations with kind 'url' so both tools map them to URL_NOT_ALLOWED (#14)", () => {
    // The handler maps NormalizationError.kind, not the message, so the kind is
    // the contract that keeps design_review and design_recheck aligned.
    for (const bad of ["http://preview.example.com", "https://user:pass@preview.example.com", "/pricing"]) {
      try {
        normalizePreviewUrl(bad);
        throw new Error(`expected ${bad} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(NormalizationError);
        expect((err as NormalizationError).kind).toBe("url");
      }
    }
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

  it("tags non-URL request violations with kind 'argument' -> INVALID_ARGUMENT (#14)", () => {
    // Route/viewport violations are NOT about the URL, so they must stay
    // INVALID_ARGUMENT rather than be reported as URL_NOT_ALLOWED.
    const cases = [
      { ...base, routes: ["pricing"] },
      { ...base, routes: ["/a", "/b", "/c", "/d", "/e", "/f"] },
    ];
    for (const input of cases) {
      try {
        normalizeReviewRequest(input);
        throw new Error("expected a NormalizationError");
      } catch (err) {
        expect(err).toBeInstanceOf(NormalizationError);
        expect((err as NormalizationError).kind).toBe("argument");
      }
    }
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
