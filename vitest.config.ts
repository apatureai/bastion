import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@apatureai/bastion-types": fromRoot("./packages/mcp-types/src/index.ts"),
      "@apatureai/bastion": fromRoot("./packages/mcp-server/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // A cold run instantiates PGlite (WASM Postgres) inside a hook; the 5s
    // default is not enough on a first, uncached run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
