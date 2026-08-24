#!/usr/bin/env bash
# Drive the bastion remote edge (Streamable HTTP + OAuth 2.1) end to end against
# a running `pnpm dev:http`. Needs only curl.
#
#   terminal 1:  pnpm build && pnpm dev:http     # prints export BASTION_TOKEN='...'
#   terminal 2:  BASTION_TOKEN='eyJ...' bash examples/dev-http-session.sh
#
# Optional: BASTION_MCP (default http://127.0.0.1:8080/mcp).
set -euo pipefail

BASTION_MCP="${BASTION_MCP:-http://127.0.0.1:8080/mcp}"
: "${BASTION_TOKEN:?set BASTION_TOKEN to the token pnpm dev:http printed}"

ACCEPT='application/json, text/event-stream'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example","version":"0"}}}'

echo "# 1. unauthenticated initialize (expect 401)"
curl -s -o /dev/null -w '   HTTP %{http_code}\n' -X POST "$BASTION_MCP" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" -d "$INIT"

echo "# 2. authenticated initialize, capture the session id"
SID=$(curl -sD - -o /dev/null -X POST "$BASTION_MCP" \
  -H "Authorization: Bearer $BASTION_TOKEN" -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d "$INIT" | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
echo "   mcp-session-id: $SID"

echo "# 3. tell the server the client is initialized"
curl -s -o /dev/null -X POST "$BASTION_MCP" \
  -H "Authorization: Bearer $BASTION_TOKEN" -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

echo "# 4. list the five tools"
curl -sN "$BASTION_MCP" -H "Authorization: Bearer $BASTION_TOKEN" -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | grep -o '"name":"design_[a-z_]*"' || true

echo "# 5. submit a review of the seeded host (returns a running job to poll)"
curl -sN "$BASTION_MCP" -H "Authorization: Bearer $BASTION_TOKEN" -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"design_review","arguments":{"url":"https://preview.example.com/pricing","client_request_id":"example-review-1"}}}' \
  | grep -o '"status": *"[a-z]*"' | head -1 || true

echo "# 6. the SSRF boundary: an unverified host is refused (DOMAIN_UNVERIFIED / verify_domain)"
curl -sN "$BASTION_MCP" -H "Authorization: Bearer $BASTION_TOKEN" -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"design_review","arguments":{"url":"https://evil.example.org/","client_request_id":"example-review-2"}}}' \
  | grep -o 'DOMAIN_UNVERIFIED\|verify_domain' | head -2 || true
