import { isIP } from "node:net";
import type { ProhibitedReason } from "./egress.js";
import { classifyAddress } from "./egress.js";

/**
 * Target authorization (TRD §7, THREAT_MODEL T1/T2). Proves that a tenant is
 * allowed to ask Apature to capture a URL, in three layers:
 *
 *   1. canonicalize the host (§7.3);
 *   2. require an ownership-verified host on the tenant allowlist (§7.2);
 *   3. require every resolved address to clear the egress denylist, with
 *      DNS-rebind / mixed-answer rejection (§7.5, T2).
 *
 * Bastion owns this policy. The pinned connection + capture stay in
 * `verdict`; the `DnsResolver` here is a seam so policy can be evaluated
 * (and tested) WITHOUT real DNS or network; tests inject a stub resolver.
 */

/** A pre-registered, ownership-verified target for a tenant (§7.2). */
export type VerifiedTarget =
  | { kind: "host"; host: string }
  | { kind: "github_deployment"; host: string }
  | { kind: "provider_project"; host: string };

/** The tenant's verified-domain registry, as Bastion reads it. */
export type TenantAllowlist = {
  tenantId: string;
  targets: VerifiedTarget[];
};

/** Resolves a hostname to its A/AAAA addresses. A seam, so never real net in tests. */
export interface DnsResolver {
  resolve(host: string): Promise<string[]>;
}

export type TargetAuthFailureReason =
  | "not_https"
  | "userinfo_present"
  | "ip_literal"
  | "unparseable"
  | "domain_unverified"
  | "no_dns_records"
  | "dns_rebind"
  | { egress: ProhibitedReason };

export class TargetAuthError extends Error {
  readonly reason: TargetAuthFailureReason;
  constructor(reason: TargetAuthFailureReason, message: string) {
    super(message);
    this.name = "TargetAuthError";
    this.reason = reason;
  }
}

/** The canonical, authorized form of a target (§7.3 output). */
export type CanonicalTarget = {
  /** Full canonical URL (https, no userinfo, no fragment, normalized host/path). */
  url: string;
  /** Lowercased, IDNA-normalized host with the default port removed. */
  host: string;
};

/**
 * Canonicalize a preview URL per §7.3. Stricter than the #1 normalizer: it also
 * lowercases/IDNA-normalizes the host, drops the default port, normalizes an
 * empty path to "/", and REJECTS IP-literal targets (customer previews must use
 * an ownership-verified hostname, never a raw IP).
 */
export function canonicalizeTarget(raw: string): CanonicalTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TargetAuthError("unparseable", `url is not a valid absolute URL: ${raw}`);
  }

  if (parsed.protocol !== "https:") {
    throw new TargetAuthError("not_https", "only https preview URLs are supported in v1");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TargetAuthError("userinfo_present", "credentials in the URL are not allowed");
  }

  // WHATWG URL lowercases and IDNA-encodes the host and drops the default :443.
  // IPv6 literals come back bracketed (e.g. "[::1]"); strip the brackets so
  // `isIP` recognizes them and the denylist sees a bare address.
  const rawHost = parsed.hostname;
  if (rawHost === "") {
    throw new TargetAuthError("unparseable", "url has no host");
  }
  const host =
    rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  // Reject IP-literal targets for customer previews (§7.3, T1).
  if (isIP(host) !== 0) {
    throw new TargetAuthError("ip_literal", "IP-literal targets are not allowed for previews");
  }

  parsed.hash = "";
  if (parsed.pathname === "") parsed.pathname = "/";

  return { url: parsed.toString(), host };
}

/**
 * Exact-host membership against the tenant allowlist (§7.2). Verification
 * authorizes the EXACT host, never a wildcard or parent suffix, so a bare
 * label-suffix match is deliberately NOT accepted. Hosts are compared after
 * canonicalization (both already lowercased).
 */
export function isHostVerified(host: string, allowlist: TenantAllowlist): boolean {
  return allowlist.targets.some((t) => t.host.toLowerCase() === host);
}

/**
 * Full target authorization. Throws `TargetAuthError` on any policy failure;
 * returns the canonical target on success. The resolver is consulted only after
 * the host is verified, and every returned address must clear the egress
 * denylist. A mix of allowed and prohibited answers is treated as a rebind
 * attempt and rejected wholesale (T2).
 */
export async function authorizeTarget(
  raw: string,
  allowlist: TenantAllowlist,
  resolver: DnsResolver,
): Promise<CanonicalTarget> {
  const target = canonicalizeTarget(raw);

  if (!isHostVerified(target.host, allowlist)) {
    throw new TargetAuthError(
      "domain_unverified",
      `host ${target.host} is not an ownership-verified target for tenant ${allowlist.tenantId}`,
    );
  }

  const addresses = await resolver.resolve(target.host);
  if (addresses.length === 0) {
    throw new TargetAuthError("no_dns_records", `host ${target.host} resolved to no addresses`);
  }

  let sawProhibited: ProhibitedReason | null = null;
  let sawAllowed = false;
  for (const addr of addresses) {
    const verdict = classifyAddress(addr);
    if (verdict.allowed) {
      sawAllowed = true;
    } else {
      sawProhibited ??= verdict.reason;
    }
  }

  // Mixed public/private answer set -> rebind/TOCTOU; reject the whole resolve.
  if (sawProhibited !== null && sawAllowed) {
    throw new TargetAuthError(
      "dns_rebind",
      `host ${target.host} returned a mix of public and prohibited addresses`,
    );
  }
  if (sawProhibited !== null) {
    throw new TargetAuthError(
      { egress: sawProhibited },
      `host ${target.host} resolves to a prohibited (${sawProhibited}) address`,
    );
  }

  return target;
}
