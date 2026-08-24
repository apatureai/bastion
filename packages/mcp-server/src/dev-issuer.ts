import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";

/**
 * A throwaway OAuth 2.1 authorization server, for local development only.
 *
 * The production HTTP edge (`http-server.ts` + `jwt-verifier.ts`) is a bearer
 * PROTECTED RESOURCE: it verifies an access token's signature against an
 * issuer's JWKS, its `iss`, its `aud`, and its expiry, then reads `tenant_id`
 * and `scope` off the claims. That is faithful to how a real deployment works,
 * and it is also why the remote surface could not be experienced without
 * standing up an issuer first. This module is that issuer, in-process: it
 * generates an ES256 keypair, serves the public half as a JWKS a
 * `createRemoteJWKSet` verifier fetches for real, and mints tokens carrying the
 * exact claims the verifier requires.
 *
 * It is NEVER wired into `production.ts`. It exists so `dev-http.ts` can boot
 * the real transport, the real verifier, and the real SSRF boundary against a
 * fixture engine, and hand a developer a working token — not so any of this
 * signing key material reaches a deployment. The keypair lives only in memory
 * and changes every boot.
 */

export interface DevIssuerOptions {
  /** Issuer identity (`iss`). Default `http://127.0.0.1:<port>`. */
  issuer?: string;
  /** Audience minted tokens carry (`aud`): the MCP server's resource id. */
  audience: string;
  /** Loopback port for the JWKS/token endpoints. Default: an ephemeral port. */
  port?: number;
  /** Bind host. Default `127.0.0.1`; never bind a dev issuer to a public interface. */
  host?: string;
}

export interface MintOptions {
  /** The tenant the token is for (`tenant_id`). Default `dev-tenant`. */
  tenantId?: string;
  /** The client identity (`client_id`/`sub`). Default `dev-agent`. */
  clientId?: string;
  /** Space-delimited scopes. Default `reviews:cancel` so every tool is reachable. */
  scope?: string;
  /** Token lifetime in seconds. Default 3600. */
  expiresInSec?: number;
}

export interface DevIssuer {
  /** The issuer identity minted tokens carry, and the verifier expects as `iss`. */
  issuer: string;
  /** The JWKS URL a `createRemoteJWKSet` verifier fetches signature keys from. */
  jwksUrl: string;
  /** The `POST /dev/token` endpoint a developer can curl for a fresh token. */
  tokenUrl: string;
  /** Mint a signed access token with the claims the verifier requires. */
  mint(options?: MintOptions): Promise<string>;
  /** Stop the JWKS/token HTTP server. */
  close(): Promise<void>;
  /** The bound port (useful when `port` was left ephemeral). */
  port: number;
}

const JWKS_PATH = "/.well-known/jwks.json";
const TOKEN_PATH = "/dev/token";

/**
 * Start the dev issuer. Resolves once the JWKS endpoint is listening, so a
 * verifier pointed at `jwksUrl` can fetch keys immediately.
 */
export async function startDevIssuer(options: DevIssuerOptions): Promise<DevIssuer> {
  const host = options.host ?? "127.0.0.1";
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
  const jwks = { keys: [publicJwk] };

  let issuer = options.issuer ?? "";

  const mint = async (mintOptions: MintOptions = {}): Promise<string> => {
    const clientId = mintOptions.clientId ?? "dev-agent";
    return await new SignJWT({
      tenant_id: mintOptions.tenantId ?? "dev-tenant",
      scope: mintOptions.scope ?? "reviews:cancel",
      client_id: clientId,
    })
      .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(options.audience)
      .setSubject(clientId)
      .setIssuedAt()
      .setExpirationTime(`${mintOptions.expiresInSec ?? 3600}s`)
      .sign(privateKey);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || `http://${host}`);
    if (req.method === "GET" && url.pathname === JWKS_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jwks));
      return;
    }
    if (req.method === "POST" && url.pathname === TOKEN_PATH) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: MintOptions = {};
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as MintOptions;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "request body is not JSON" }));
            return;
          }
        }
        mint(body)
          .then((token) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: token, token_type: "Bearer" }));
          })
          .catch((error: unknown) => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  if (issuer === "") issuer = `http://${host}:${port}`;

  return {
    issuer,
    jwksUrl: `${issuer}${JWKS_PATH}`,
    tokenUrl: `${issuer}${TOKEN_PATH}`,
    mint,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
