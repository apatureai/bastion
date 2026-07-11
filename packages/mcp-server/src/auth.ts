import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Bearer-token authentication for the remote MCP surface (#28). MCP Review is a
 * PROTECTED RESOURCE (RFC 9728 / OAuth 2.1): every request carries a bearer
 * access token issued by the tenant's authorization server, and the server
 * verifies it before any tool runs. Verification itself (JWKS, audience,
 * issuer, expiry) is deployment configuration behind the injected
 * `TokenVerifier` port, so tests never reach a real IdP.
 *
 * The verified `AuthInfo.extra.tenantId` scopes the per-session review service.
 * Durable review state lives in the application store keyed by product job ids,
 * NEVER in the MCP transport session — a session is only a routing handle.
 */

/** The scope a token must carry to use the cancel tool (least privilege). */
export const REVIEWS_CANCEL_SCOPE = "reviews:cancel";

/** Verifies a bearer access token, or rejects it. Injected; no real IdP in tests. */
export interface TokenVerifier {
  /**
   * Resolve a raw bearer token to its `AuthInfo`, or throw `TokenInvalidError`
   * / return `null` when the token is missing/expired/invalid/wrong-audience.
   * The verifier MUST populate `extra.tenantId` — the tenant the token is for.
   */
  verify(token: string): Promise<AuthInfo | null>;
}

export class TokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenInvalidError";
  }
}

/** The verified principal a request runs as. */
export interface Principal {
  tenantId: string;
  clientId: string;
  scopes: readonly string[];
  auth: AuthInfo;
}

/** Extract the tenant id a verifier stamped onto the token's `extra`. */
export function tenantOf(auth: AuthInfo): string {
  const tenantId = (auth.extra as { tenantId?: unknown } | undefined)?.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new TokenInvalidError("verified token carries no tenant identity");
  }
  return tenantId;
}

/** Parse a single, well-formed `Authorization: Bearer <token>` header. */
export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer (.+)$/.exec(headerValue.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Authenticate a request from its Authorization header. Returns the verified
 * `Principal`, or `null` when the token is absent or invalid — the caller then
 * answers 401 with a `WWW-Authenticate` challenge pointing at the
 * protected-resource metadata. Non-enumerating: absent and invalid tokens are
 * indistinguishable to the client.
 */
export async function authenticate(
  verifier: TokenVerifier,
  authorizationHeader: string | undefined,
): Promise<Principal | null> {
  const token = bearerToken(authorizationHeader);
  if (!token) return null;
  let auth: AuthInfo | null;
  try {
    auth = await verifier.verify(token);
  } catch {
    return null;
  }
  if (!auth) return null;
  let tenantId: string;
  try {
    tenantId = tenantOf(auth);
  } catch {
    return null;
  }
  return { tenantId, clientId: auth.clientId, scopes: auth.scopes, auth };
}

/**
 * RFC 9728 protected-resource metadata served at
 * `/.well-known/oauth-protected-resource`. `resourceUrl` is this server's
 * canonical resource identifier; `authorizationServers` are the issuer URLs a
 * client should obtain a token from.
 */
export function protectedResourceMetadata(
  resourceUrl: string,
  authorizationServers: readonly string[],
): Record<string, unknown> {
  return {
    resource: resourceUrl,
    authorization_servers: [...authorizationServers],
    bearer_methods_supported: ["header"],
    scopes_supported: [REVIEWS_CANCEL_SCOPE],
    resource_documentation: "https://apature.ai/docs/mcp",
  };
}

/** The `WWW-Authenticate` value pointing a client at the PRM discovery doc. */
export function wwwAuthenticate(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}"`;
}
