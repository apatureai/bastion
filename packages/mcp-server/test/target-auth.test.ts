import { describe, expect, it } from "vitest";
import {
  authorizeTarget,
  canonicalizeTarget,
  isHostVerified,
  TargetAuthError,
} from "../src/index.js";
import type { DnsResolver, TenantAllowlist } from "../src/index.js";

const allowlist: TenantAllowlist = {
  tenantId: "tenant-1",
  targets: [
    { kind: "host", host: "preview.example.com" },
    { kind: "github_deployment", host: "app-pr-42.vercel.app" },
  ],
};

/** Stub resolver: maps known hosts to fixed addresses. Never real DNS. */
function resolverFor(map: Record<string, string[]>): DnsResolver {
  return { resolve: async (host) => map[host] ?? [] };
}

const publicResolver = resolverFor({
  "preview.example.com": ["93.184.216.34"],
  "app-pr-42.vercel.app": ["76.76.21.21"],
});

describe("canonicalizeTarget (TRD §7.3)", () => {
  it("lowercases the host and drops the default port", () => {
    const t = canonicalizeTarget("https://Preview.Example.com:443/Pricing");
    expect(t.host).toBe("preview.example.com");
    expect(t.url).toBe("https://preview.example.com/Pricing");
  });

  it("normalizes an empty path to /", () => {
    expect(canonicalizeTarget("https://preview.example.com").url).toBe(
      "https://preview.example.com/",
    );
  });

  it("rejects http", () => {
    expect(() => canonicalizeTarget("http://preview.example.com")).toThrowError(TargetAuthError);
  });

  it("rejects userinfo", () => {
    expect(() => canonicalizeTarget("https://u:p@preview.example.com")).toThrowError(
      TargetAuthError,
    );
  });

  it("rejects an IPv4-literal target", () => {
    try {
      canonicalizeTarget("https://93.184.216.34/");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetAuthError);
      expect((err as TargetAuthError).reason).toBe("ip_literal");
    }
  });

  it("rejects an IPv6-literal target", () => {
    expect(() => canonicalizeTarget("https://[::1]/")).toThrowError(TargetAuthError);
  });
});

describe("isHostVerified (TRD §7.2 — exact host, no wildcard)", () => {
  it("matches an exact verified host", () => {
    expect(isHostVerified("preview.example.com", allowlist)).toBe(true);
  });

  it("does NOT match a subdomain of a verified host", () => {
    expect(isHostVerified("evil.preview.example.com", allowlist)).toBe(false);
  });

  it("does NOT match the parent suffix", () => {
    expect(isHostVerified("example.com", allowlist)).toBe(false);
  });

  it("does NOT match an unrelated host", () => {
    expect(isHostVerified("attacker.com", allowlist)).toBe(false);
  });
});

describe("authorizeTarget (full SSRF guard — issue #4)", () => {
  it("authorizes a verified host that resolves to a public address", async () => {
    const t = await authorizeTarget("https://preview.example.com/pricing", allowlist, publicResolver);
    expect(t.host).toBe("preview.example.com");
  });

  it("rejects an unverified host as domain_unverified", async () => {
    await expect(
      authorizeTarget("https://attacker.com/", allowlist, publicResolver),
    ).rejects.toMatchObject({ reason: "domain_unverified" });
  });

  it("rejects a verified host that resolves to a private address (egress)", async () => {
    const resolver = resolverFor({ "preview.example.com": ["10.0.0.5"] });
    await expect(
      authorizeTarget("https://preview.example.com/", allowlist, resolver),
    ).rejects.toMatchObject({ reason: { egress: "private" } });
  });

  it("rejects a verified host that resolves to the metadata IP", async () => {
    const resolver = resolverFor({ "preview.example.com": ["169.254.169.254"] });
    await expect(
      authorizeTarget("https://preview.example.com/", allowlist, resolver),
    ).rejects.toMatchObject({ reason: { egress: "metadata" } });
  });

  it("rejects a mixed public/private answer set as a rebind attempt (T2)", async () => {
    const resolver = resolverFor({ "preview.example.com": ["93.184.216.34", "127.0.0.1"] });
    await expect(
      authorizeTarget("https://preview.example.com/", allowlist, resolver),
    ).rejects.toMatchObject({ reason: "dns_rebind" });
  });

  it("rejects a host that resolves to no addresses", async () => {
    const resolver = resolverFor({});
    await expect(
      authorizeTarget("https://preview.example.com/", allowlist, resolver),
    ).rejects.toMatchObject({ reason: "no_dns_records" });
  });
});
