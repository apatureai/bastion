/**
 * Network egress policy (TRD §7.5, THREAT_MODEL T1). Pure, dependency-free
 * classification of an IP address as a *prohibited* capture destination:
 * private, loopback, link-local, cloud metadata, multicast, or reserved.
 *
 * MCP Review owns this *policy*; the actual DNS resolution + pinned connection
 * lives in `judgment-engine`. This module is the shared predicate both sides
 * agree on, so it must be exhaustive and easy to audit. It NEVER touches the
 * network — it classifies an address string a resolver already produced.
 */

/** Why an address is prohibited (surfaced in errors and tests). */
export type ProhibitedReason =
  | "loopback"
  | "private"
  | "link_local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "unspecified"
  | "unparseable";

/** Result of classifying a single address. */
export type EgressVerdict = { allowed: true } | { allowed: false; reason: ProhibitedReason };

const ALLOWED: EgressVerdict = { allowed: true };

/** The cloud-metadata endpoint, called out explicitly (AWS/GCP/Azure/OpenStack). */
const METADATA_IPV4 = "169.254.169.254";

/** Parse a dotted-quad IPv4 string into four octets, or null if malformed. */
function parseIpv4(addr: string): [number, number, number, number] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Classify an IPv4 address. */
function classifyIpv4(addr: string): EgressVerdict {
  if (addr === METADATA_IPV4) return { allowed: false, reason: "metadata" };

  const octets = parseIpv4(addr);
  if (!octets) return { allowed: false, reason: "unparseable" };
  const [a, b] = octets;

  if (a === 0) return { allowed: false, reason: "unspecified" }; // 0.0.0.0/8
  if (a === 127) return { allowed: false, reason: "loopback" }; // 127.0.0.0/8
  if (a === 10) return { allowed: false, reason: "private" }; // 10.0.0.0/8
  if (a === 172 && b! >= 16 && b! <= 31) return { allowed: false, reason: "private" }; // 172.16/12
  if (a === 192 && b === 168) return { allowed: false, reason: "private" }; // 192.168/16
  if (a === 169 && b === 254) return { allowed: false, reason: "link_local" }; // 169.254/16
  if (a === 100 && b! >= 64 && b! <= 127) return { allowed: false, reason: "reserved" }; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return { allowed: false, reason: "reserved" }; // 192.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return { allowed: false, reason: "reserved" }; // TEST-NET-1
  if (a === 198 && b === 51 && octets[2] === 100) return { allowed: false, reason: "reserved" }; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return { allowed: false, reason: "reserved" }; // TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return { allowed: false, reason: "reserved" }; // 198.18/15 bench
  if (a! >= 224 && a! <= 239) return { allowed: false, reason: "multicast" }; // 224/4
  if (a! >= 240) return { allowed: false, reason: "reserved" }; // 240/4 incl. 255.255.255.255

  return ALLOWED;
}

/** Expand an IPv6 string to eight 16-bit groups, or null if malformed. */
function expandIpv6(input: string): number[] | null {
  let addr = input;
  // Strip zone id (e.g. fe80::1%eth0) — never trusted for policy.
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  // IPv4-mapped/embedded tail (e.g. ::ffff:127.0.0.1) handled by the caller;
  // here we only parse the pure-hextet form.
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseGroups(addr);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseGroups(halves[0]!);
  const tail = parseGroups(halves[1]!);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Classify an IPv6 address (including IPv4-mapped forms). */
function classifyIpv6(addr: string): EgressVerdict {
  // IPv4-mapped or -embedded: classify the embedded IPv4 with v4 rules so
  // ::ffff:169.254.169.254 and ::ffff:127.0.0.1 cannot bypass the v4 denylist.
  const v4Match = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match && addr.includes(":")) {
    const v4 = classifyIpv4(v4Match[1]!);
    if (!v4.allowed) return v4;
  }

  const groups = expandIpv6(addr);
  if (!groups) return { allowed: false, reason: "unparseable" };

  const isAllZero = groups.every((g) => g === 0);
  if (isAllZero) return { allowed: false, reason: "unspecified" }; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { allowed: false, reason: "loopback" }; // ::1
  }

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return { allowed: false, reason: "private" }; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return { allowed: false, reason: "link_local" }; // fe80::/10
  if ((first & 0xff00) === 0xff00) return { allowed: false, reason: "multicast" }; // ff00::/8

  return ALLOWED;
}

/** True when `addr` looks like an IPv6 literal. */
function looksIpv6(addr: string): boolean {
  return addr.includes(":");
}

/**
 * Classify a resolved IP address against the egress denylist. The input must be
 * a bare address string (no brackets); IPv4, IPv6, and IPv4-mapped IPv6 are all
 * supported. Anything unrecognized is denied (fail closed).
 */
export function classifyAddress(addr: string): EgressVerdict {
  const trimmed = addr.trim();
  if (trimmed === "") return { allowed: false, reason: "unparseable" };
  return looksIpv6(trimmed) ? classifyIpv6(trimmed) : classifyIpv4(trimmed);
}

/** Convenience: true when the address is a safe public capture destination. */
export function isAddressAllowed(addr: string): boolean {
  return classifyAddress(addr).allowed;
}
