# Security Policy

## Supported versions

This repository is developed on `main`. The current release is `v0.1.0`; nothing is published to
npm yet. `main` is the supported version: fixes land there first, and anyone running this code
should track it rather than pinning a tag.

| Version | Supported |
|---|---|
| `main` | Yes |
| Older commits | No, rebase or pull forward |

## Reporting a vulnerability

Report privately through GitHub, not in a public issue or pull request:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory.

Private vulnerability reporting is enabled on this repository. If you cannot use it for any reason,
open a public issue that says only that you have a security report and asks for a private channel,
with no details in it.

Useful reports include the affected file or endpoint, a description of the impact, and the smallest
reproduction you have. A failing test against this tree is the ideal form.

### What to expect

- **Acknowledgement within 3 working days.** If you have heard nothing after that, ping the advisory
  thread.
- **An assessment within 10 working days**, saying whether the report is accepted, and if so what
  the severity and rough timeline look like.
- **A fix on `main`** for accepted reports, and a GitHub security advisory published once the fix
  lands. Timeline depends on severity; critical issues are worked immediately.
- **Credit in the advisory** unless you prefer otherwise.
- There is no bug bounty and no payment. This is maintained work, not a funded program, and reports
  are handled by one maintainer.

Please give a reasonable window to fix an accepted issue before publishing, and do not test against
infrastructure you do not own.

## Scope

In scope: everything in this repository, including the MCP tool surface, the Streamable HTTP edge,
token verification, the target-authorization and egress boundary, the Postgres application plane
and its migrations, and the review panel HTML.

Out of scope: third-party dependency advisories with no exploitable path through this code (report
those upstream and open a normal issue here so the pin gets bumped), and any hosted endpoint. There
is no hosted service today. The URL retained in `directory/server.json` documents the shape a
self-hosted deployment publishes; it is not a live target, and testing against it is not testing
this project.

## If you are going to run this code

This is production-shaped server code designed to run inside an operated environment. Things worth
knowing before you expose it to a network:

- **The auth path has not had an external security review.** Bearer-token and JWT verification live
  in `packages/mcp-server/src/auth.ts` and `jwt-verifier.ts` and depend on `jose` plus the JWKS
  endpoints you configure. Read that code and keep the dependency current. An external review of
  this path is welcome and would be a genuinely valuable contribution.
- **Review-target authorization is the SSRF boundary.** The server only reviews preview hosts a
  tenant has ownership-verified, with address classification in
  `packages/mcp-server/src/egress.ts`. Weakening either turns the server into an SSRF vector against
  your own network. Note that the ownership *proofs* themselves are issued outside this repository
  today: rows in the verified-target table are expected to arrive pre-verified, so whatever you wire
  into that table is part of your trust boundary. This is roadmap item 5 in the README.
- **Give it a throwaway database first.** In HTTP mode it runs migrations against `DATABASE_URL` at
  boot. Tables are tenant-keyed with RLS and the role must not hold `BYPASSRLS`.
- **Audit dependencies before deploying**: `pnpm install && pnpm audit`, then upgrade.
- **Page content is untrusted input.** The server reads previews an attacker may control. Nothing
  captured from a page is allowed to become an instruction, an authorization decision, or a tool
  call, and everything page-derived is escaped in the panel. Preserve that if you extend it.

The local server (`pnpm start:local`) takes no credentials and opens no network connections, but it
is not a sandbox: it is the same code path with a fixture engine and a stub resolver. Target
authorization still runs there, and weakening it there weakens it everywhere.
