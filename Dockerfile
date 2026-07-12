# Deployable remote MCP Review server (#28). Multi-stage: build the workspace,
# then run the mcp-server entrypoint. Fails closed without required env
# (MCP_RESOURCE_URL, MCP_AUTHORIZATION_SERVERS, MCP_JWKS_URL, MCP_TOKEN_ISSUER).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-slim AS run
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
# The entrypoint boots only when required env is present; healthz at /livez, /readyz.
CMD ["node", "packages/mcp-server/dist/main.js"]
