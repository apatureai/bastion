import { describe, expect, it } from "vitest";
import { classifyAddress, isAddressAllowed } from "../src/index.js";

describe("classifyAddress — IPv4 denylist (TRD §7.5, T1)", () => {
  const denied: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.1.1", "link_local"],
    ["169.254.169.254", "metadata"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["240.0.0.1", "reserved"],
  ];

  for (const [addr, reason] of denied) {
    it(`denies ${addr} as ${reason}`, () => {
      const verdict = classifyAddress(addr);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe(reason);
    });
  }

  it("172.15 and 172.32 are public (boundary of 172.16/12)", () => {
    expect(isAddressAllowed("172.15.0.1")).toBe(true);
    expect(isAddressAllowed("172.32.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isAddressAllowed("93.184.216.34")).toBe(true);
    expect(isAddressAllowed("8.8.8.8")).toBe(true);
  });

  it("denies malformed IPv4 (fail closed)", () => {
    expect(isAddressAllowed("999.1.1.1")).toBe(false);
    expect(isAddressAllowed("1.2.3")).toBe(false);
  });
});

describe("classifyAddress — IPv6 denylist", () => {
  const denied: Array<[string, string]> = [
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link_local"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["ff02::1", "multicast"],
  ];

  for (const [addr, reason] of denied) {
    it(`denies ${addr} as ${reason}`, () => {
      const verdict = classifyAddress(addr);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe(reason);
    });
  }

  it("denies IPv4-mapped loopback and metadata (dotted ::ffff: form)", () => {
    expect(isAddressAllowed("::ffff:127.0.0.1")).toBe(false);
    expect(isAddressAllowed("::ffff:169.254.169.254")).toBe(false);
  });

  it("denies the ALL-HEX IPv4-mapped form (regression: hex bypass)", () => {
    // Same addresses as above, spelled with hex hextets instead of a dotted
    // tail. These previously slipped past the dotted-tail regex and returned
    // ALLOW — a real cloud-metadata / loopback / RFC-1918 SSRF bypass.
    const mapped: Array<[string, string]> = [
      ["::ffff:a9fe:a9fe", "metadata"], // 169.254.169.254
      ["::ffff:7f00:1", "loopback"], // 127.0.0.1
      ["::ffff:c0a8:1", "private"], // 192.168.0.1
      ["::ffff:0a00:1", "private"], // 10.0.0.1
    ];
    for (const [addr, reason] of mapped) {
      const verdict = classifyAddress(addr);
      expect(verdict.allowed, `${addr} must be denied`).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe(reason);
    }
  });

  it("denies IPv4-compatible (::/96) internal addresses in hex form", () => {
    expect(isAddressAllowed("::7f00:1")).toBe(false); // ::127.0.0.1 loopback
    expect(isAddressAllowed("::a9fe:a9fe")).toBe(false); // ::169.254.169.254 metadata
  });

  it("denies 6to4 (2002::/16) wrapping internal addresses", () => {
    expect(isAddressAllowed("2002:7f00:1::")).toBe(false); // wraps 127.0.0.1
    expect(isAddressAllowed("2002:a9fe:a9fe::")).toBe(false); // wraps 169.254.169.254
    expect(isAddressAllowed("2002:c0a8:1::")).toBe(false); // wraps 192.168.0.1
  });

  it("still allows a 6to4 address wrapping a public v4", () => {
    expect(isAddressAllowed("2002:5db8:d822::")).toBe(true); // wraps 93.184.216.34
  });

  it("strips a zone id before classifying", () => {
    expect(isAddressAllowed("fe80::1%eth0")).toBe(false);
  });

  it("allows a public IPv6 address", () => {
    expect(isAddressAllowed("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });
});
