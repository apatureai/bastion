# Security Policy

## This project is archived and unmaintained

Apature has been wound down. This repository is published as a historical
snapshot of the MCP Review server. It receives **no security support**:

- no supported versions, and no patch releases — not even for critical issues;
- no security advisories will be published, and no CVEs will be requested;
- no bug bounty, and no reward or acknowledgement program of any kind;
- no guaranteed response time, and no guarantee of any response at all.

Dependency updates stopped when the project stopped. `pnpm-lock.yaml` pins the
versions that were current at the final commit; assume some of them have known
vulnerabilities by the time you read this.

## Reporting a vulnerability anyway

If you find something and want to report it as a courtesy to others who may
fork this code, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory.

If that option is unavailable (archived repositories restrict some GitHub
features), the most useful thing you can do is publish your findings in your
own fork's README so downstream forks can see them. Please do not expect a fix
here.

Do not report issues in the hosted Apature service. It is no longer operated,
and the endpoint retained in `directory/server.json` (`https://mcp.apature.ai/mcp`)
should be treated as dead, not as a live target.

## If you are going to run this code

This was production-shaped server code, not a demo, and it was designed to run
inside an operated environment. Read it before you trust it:

- **Do not point it at production secrets or production data.** It boots only
  with real auth configuration (`MCP_RESOURCE_URL`, `MCP_AUTHORIZATION_SERVERS`,
  `MCP_JWKS_URL`, `MCP_TOKEN_ISSUER`) and, in production mode, a Postgres
  connection whose migrations it will run. Give it a throwaway database and
  throwaway credentials.
- **The auth path is unreviewed as of archival.** Bearer-token and JWT
  verification (`packages/mcp-server/src/auth.ts`, `jwt-verifier.ts`,
  `target-auth.ts`) depends on `jose` and on JWKS endpoints you configure. If
  you fork this, re-review that code and update the dependency yourself.
- **Review-target authorization matters.** The server is designed to only
  review preview hosts a tenant has ownership-verified, with egress controls in
  `packages/mcp-server/src/egress.ts`. Weakening that turns the server into an
  SSRF vector against your own network. Note that the ownership *proofs*
  themselves were issued outside this repository — see the Limitations section
  of the README.
- **Audit dependencies first**: `pnpm install && pnpm audit`, then upgrade
  before exposing anything to a network.

The offline server (`pnpm start:local`) takes no credentials and opens no
network connections, but it is not a sandbox: it is the same code path with a
fixture engine and a stub resolver. Target authorization still runs, and
weakening it there weakens it everywhere.
