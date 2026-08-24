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

  it("rejects http on a remote host", () => {
    try {
      canonicalizeTarget("http://preview.example.com");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetAuthError);
      expect((err as TargetAuthError).reason).toBe("not_https");
    }
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

  it("rejects a non-loopback IPv6-literal target", () => {
    try {
      canonicalizeTarget("https://[2606:4700:4700::1111]/");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetAuthError);
      expect((err as TargetAuthError).reason).toBe("ip_literal");
    }
  });

  describe("loopback dev-host exception (localhost, 127.0.0.0/8, ::1)", () => {
    it("allows plain http to localhost, keeping the port", () => {
      const t = canonicalizeTarget("http://localhost:5173/pricing");
      expect(t.host).toBe("localhost");
      expect(t.url).toBe("http://localhost:5173/pricing");
    });

    it("allows a 127.0.0.0/8 IPv4 literal over http", () => {
      const t = canonicalizeTarget("http://127.0.0.1:3000/");
      expect(t.host).toBe("127.0.0.1");
      expect(t.url).toBe("http://127.0.0.1:3000/");
    });

    it("allows the ::1 IPv6 literal over http", () => {
      const t = canonicalizeTarget("http://[::1]:8080/");
      expect(t.host).toBe("::1");
      expect(t.url).toBe("http://[::1]:8080/");
    });

    it("also allows https to a loopback host", () => {
      expect(canonicalizeTarget("https://localhost/").url).toBe("https://localhost/");
    });

    it("does NOT extend the exception to a non-loopback private host over http", () => {
      // 10.x is private, not loopback: it gets neither the http nor the
      // IP-literal relief, and is rejected at the scheme gate.
      try {
        canonicalizeTarget("http://10.0.0.5/");
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(TargetAuthError);
        expect((err as TargetAuthError).reason).toBe("not_https");
      }
    });

    it("does NOT treat a hostname that merely contains 'localhost' as loopback", () => {
      expect(() => canonicalizeTarget("http://localhost.evil.com/")).toThrowError(TargetAuthError);
    });
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

  it("authorizes an explicitly named loopback dev host without allowlist or DNS", async () => {
    // localhost is not on the allowlist and the resolver knows nothing about it;
    // the exception short-circuits before either is consulted.
    const emptyList: TenantAllowlist = { tenantId: "tenant-1", targets: [] };
    const t = await authorizeTarget("http://localhost:5173/", emptyList, resolverFor({}));
    expect(t.host).toBe("localhost");
    expect(t.url).toBe("http://localhost:5173/");
  });

  it("still rejects a PUBLIC host that resolves ONLY to loopback (rebind, not the exception)", async () => {
    // The exception is keyed on the literal host, so a verified public name that
    // resolves to 127.0.0.1 gets no relief and is stopped by the egress denylist.
    const resolver = resolverFor({ "preview.example.com": ["127.0.0.1"] });
    await expect(
      authorizeTarget("https://preview.example.com/", allowlist, resolver),
    ).rejects.toMatchObject({ reason: { egress: "loopback" } });
  });
});
