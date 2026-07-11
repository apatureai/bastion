import { jwtVerify, type JWTVerifyGetKey, type KeyObject } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { TokenInvalidError, type TokenVerifier } from "./auth.js";

/**
 * OAuth 2.1 bearer JWT verifier (#28). Verifies the access token's signature,
 * issuer, audience (this server's resource identifier, RFC 8707), and expiry,
 * then projects its claims to `AuthInfo` with `extra.tenantId`.
 *
 * The key source is injected: production wires `createRemoteJWKSet(issuer JWKS
 * URL)`; tests pass a local key, so verification is exercised with no network.
 * A missing/invalid/expired/wrong-audience token throws `TokenInvalidError`,
 * which the auth layer turns into a non-enumerating 401.
 */
export interface JwtVerifierConfig {
  /** jose key resolver — a remote JWKS in prod, a local key in tests. */
  keySource: JWTVerifyGetKey | KeyObject | Uint8Array;
  /** Expected token issuer (`iss`). */
  issuer: string;
  /** Expected audience (`aud`) — this server's resource identifier. */
  audience: string;
  /**
   * Claim carrying the tenant id (default `tenant_id`). The tenant scopes every
   * review; a token without it is rejected.
   */
  tenantClaim?: string;
  /** Claim carrying the space-delimited scopes (default `scope`). */
  scopeClaim?: string;
}

export function createJwtVerifier(config: JwtVerifierConfig): TokenVerifier {
  const tenantClaim = config.tenantClaim ?? "tenant_id";
  const scopeClaim = config.scopeClaim ?? "scope";
  return {
    async verify(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, config.keySource as JWTVerifyGetKey, {
          issuer: config.issuer,
          audience: config.audience,
        }));
      } catch (err) {
        throw new TokenInvalidError(`token verification failed: ${(err as Error).message}`);
      }
      const tenantId = payload[tenantClaim];
      if (typeof tenantId !== "string" || tenantId.length === 0) {
        throw new TokenInvalidError(`token carries no ${tenantClaim} claim`);
      }
      const rawScope = payload[scopeClaim];
      const scopes = typeof rawScope === "string" ? rawScope.split(" ").filter(Boolean) : [];
      const clientId =
        typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string"
            ? payload.azp
            : typeof payload.sub === "string"
              ? payload.sub
              : "unknown";
      return {
        token,
        clientId,
        scopes,
        ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
        resource: new URL(config.audience),
        extra: { tenantId },
      };
    },
  };
}
