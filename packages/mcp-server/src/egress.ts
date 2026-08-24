/**
 * Network egress policy (TRD §7.5, THREAT_MODEL T1). Pure, dependency-free
 * classification of an IP address as a *prohibited* capture destination:
 * private, loopback, link-local, cloud metadata, multicast, or reserved.
 *
 * Bastion owns this *policy*; the actual DNS resolution + pinned connection
 * lives in `verdict`. This module is the shared predicate both sides
 * agree on, so it must be exhaustive and easy to audit. It NEVER touches the
 * network; it classifies an address string a resolver already produced.
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
  if (a === 192 && b === 88 && octets[2] === 99) return { allowed: false, reason: "reserved" }; // 192.88.99/24 6to4 relay anycast (RFC 3068, deprecated RFC 7526)
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
  // Strip zone id (e.g. fe80::1%eth0), never trusted for policy.
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  // A trailing dotted-decimal IPv4 (e.g. ::ffff:127.0.0.1) is rewritten to its
  // two equivalent hextets BEFORE parsing, so the expanded groups are uniform
  // regardless of whether the embedded v4 was written in dotted or hex form.
  // Both spellings then flow through the same embedded-v4 check in classifyIpv6.
  const dottedTail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedTail) {
    const octets = parseIpv4(dottedTail[1]!);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = addr.slice(0, addr.length - dottedTail[1]!.length) + `${hi}:${lo}`;
  }

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

/** Format the low 32 bits held in two hextets as a dotted IPv4 string. */
function embeddedV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Classify an IPv6 address (including IPv4-mapped/-compatible and 6to4 forms). */
function classifyIpv6(addr: string): EgressVerdict {
  const groups = expandIpv6(addr);
  if (!groups) return { allowed: false, reason: "unparseable" };

  // Embedded-IPv4 ranges: reconstruct the embedded v4 from the relevant hextets
  // and classify it with the v4 denylist, so the ALL-HEX spelling cannot bypass
  // it (e.g. ::ffff:a9fe:a9fe == ::ffff:169.254.169.254 == cloud metadata).
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (last two hextets are v4).
  const isMapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isCompat =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && !(g6 === 0 && g7 <= 1);
  if (isMapped || isCompat) {
    const v4 = classifyIpv4(embeddedV4(g6, g7));
    // The embedded v4 fully determines reachability here; even an "allowed"
    // embedded address is a real public v4 target, so return its verdict.
    return v4;
  }

  // 6to4 2002::/16: the embedded v4 is the middle two hextets (2002:V4HI:V4LO::/48).
  if (g0 === 0x2002) {
    const v4 = classifyIpv4(embeddedV4(g1, g2));
    if (!v4.allowed) return v4;
  }

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the embedded v4 is the last
  // two hextets. A DNS64/NAT64 resolver synthesizes these for v4-only hosts, so
  // 64:ff9b::a9fe:a9fe is really 169.254.169.254, the same embedded-v4 bypass
  // class as ::ffff:/6to4 above, and it must be classified by the v4 denylist.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embeddedV4(g6, g7));
  }

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

/**
 * True when a *literal* target host names the loopback interface: the name
 * `localhost`, an IPv4 literal in 127.0.0.0/8, `::1`, or an IPv4-mapped/6to4/etc.
 * spelling that resolves to a 127.x address under the same denylist.
 *
 * This is a HOST-STRING predicate, decided from what the caller LITERALLY named,
 * never from DNS resolution. A public hostname that RESOLVES to a loopback
 * address is deliberately NOT loopback here, so the egress guard still rejects
 * it as a rebind. It is the single gate for the narrow local-dev exception:
 * plain http and a skipped egress denylist are granted ONLY to an explicitly
 * named loopback target — an agent reviewing its own dev server — and to nothing
 * that merely points at one. A non-loopback private/reserved host (10.x,
 * 192.168.x, the metadata IP) is NOT loopback and gets none of the exception.
 *
 * Accepts an optional bracketed IPv6 form (`[::1]`) as `URL.hostname` returns it,
 * stripping the brackets before classification.
 */
export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "") return false;
  if (trimmed === "localhost") return true;
  const bare =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const verdict = classifyAddress(bare);
  return !verdict.allowed && verdict.reason === "loopback";
}
