/**
 * Environment-variable helpers for the composition roots.
 *
 * `required` was copy-pasted, byte-identical, into main.ts and production.ts —
 * both read required config from `process.env` at startup and must fail the same
 * way when a variable is missing. Single-sourced here so the two boot paths
 * validate environment config identically.
 */

/** Read a required environment variable, throwing a clear error when it is absent. */
export function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable ${key}`);
  return value;
}
