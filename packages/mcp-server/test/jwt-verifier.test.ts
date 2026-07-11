import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtVerifier, TokenInvalidError } from "../src/index.js";

const ISSUER = "https://auth.apature.ai";
const AUDIENCE = "https://mcp.apature.ai";

/** Sign a token locally (no network) — the verifier is tested against the public key. */
async function signed(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  over: { iss?: string; aud?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "5m")
    .sign(privateKey);
}

describe("createJwtVerifier (#28)", () => {
  it("accepts a well-formed token and projects tenant, scopes, and client", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const verifier = createJwtVerifier({ keySource: publicKey, issuer: ISSUER, audience: AUDIENCE });
    const token = await signed(privateKey, {
      tenant_id: "acme",
      scope: "reviews:read reviews:cancel",
      client_id: "agent-1",
    });
    const auth = await verifier.verify(token);
    expect(auth.extra?.tenantId).toBe("acme");
    expect(auth.scopes).toEqual(["reviews:read", "reviews:cancel"]);
    expect(auth.clientId).toBe("agent-1");
    expect(auth.resource?.toString()).toBe(`${AUDIENCE}/`);
  });

  it("rejects wrong audience, wrong issuer, and expired tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const verifier = createJwtVerifier({ keySource: publicKey, issuer: ISSUER, audience: AUDIENCE });

    const wrongAud = await signed(privateKey, { tenant_id: "acme" }, { aud: "https://evil.example" });
    await expect(verifier.verify(wrongAud)).rejects.toBeInstanceOf(TokenInvalidError);

    const wrongIss = await signed(privateKey, { tenant_id: "acme" }, { iss: "https://evil.example" });
    await expect(verifier.verify(wrongIss)).rejects.toBeInstanceOf(TokenInvalidError);

    const expired = await signed(privateKey, { tenant_id: "acme" }, { exp: "-1m" });
    await expect(verifier.verify(expired)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("rejects a token signed by the wrong key (forgery)", async () => {
    const good = await generateKeyPair("ES256");
    const attacker = await generateKeyPair("ES256");
    const verifier = createJwtVerifier({ keySource: good.publicKey, issuer: ISSUER, audience: AUDIENCE });
    const forged = await signed(attacker.privateKey, { tenant_id: "acme" });
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("rejects a valid signature that carries no tenant claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const verifier = createJwtVerifier({ keySource: publicKey, issuer: ISSUER, audience: AUDIENCE });
    const noTenant = await signed(privateKey, { scope: "reviews:cancel" });
    await expect(verifier.verify(noTenant)).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
