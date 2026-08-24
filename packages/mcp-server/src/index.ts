export { createMcpReviewServer } from "./server.js";
export type { McpReviewServerDeps } from "./server.js";
// The local composition root: the same five tools with fixture judgments by
// default, or a verdict-backed engine when the environment configures one.
export {
  createLocalDnsResolver,
  createLocalReviewServer,
  LOCAL_ALLOWED_HOST,
  LOCAL_RESOLVED_ADDRESS,
} from "./local-server.js";
export type { LocalReviewServerOptions } from "./local-server.js";
// The critique backends. `resolveEngineRuntime` reads the environment and says,
// in one line, whether the findings will come from a model or from a fixture.
export {
  EngineConfigError,
  resolveEngineRuntime,
  resolveVerdictCliEntry,
  resolveVerdictModel,
} from "./engine-runtime.js";
export type { EngineMode, EngineRuntime, ResolveEngineRuntimeOptions } from "./engine-runtime.js";
export {
  noModelDisclosure,
  spawnProcessRunner,
  VerdictCliEngineClient,
} from "./verdict-cli-engine.js";
export type {
  ProcessResult,
  ProcessRunner,
  VerdictCliEngineOptions,
  VerdictModelChoice,
} from "./verdict-cli-engine.js";
export { VerdictJobEngineClient } from "./verdict-job-engine.js";
export type { VerdictJobEngineOptions } from "./verdict-job-engine.js";
// Judgment provenance: the stamp every backend applies at the engine boundary
// and `critique-map.ts` / `recheck-map.ts` enforce, so a payload states in-band
// whether anything actually judged the page.
export {
  FIXTURE_PROVENANCE,
  FIXTURE_RECHECK_PROVENANCE,
  NO_MODEL_DISCLOSURE_PREFIX,
  stampProvenance,
  stampRecheckProvenance,
  UNATTESTED_PROVENANCE,
  unjudgedRecheckReason,
  verdictCliProvenance,
  verdictHttpProvenance,
} from "./provenance.js";
export { EngineResultError, parseEngineReviewResult } from "./engine-result.js";
export type { EvidenceProvider } from "./evidence.js";
export { SyntheticEvidenceProvider, renderPlaceholderPng } from "./synthetic-evidence.js";
export { renderReviewPanel, escapeHtml } from "./panel-html.js";
// D3 (#58): multimedia-native design_review result shaping: annotated screenshot
// image blocks + the interactive MCP-Apps HTML panel, each with an honest
// capability downgrade for hosts that can't render them.
export {
  buildMultimediaCritiqueContent,
  buildDesignReviewContent,
  MCP_APP_PANEL_MIME,
  UNJUDGED_BLOCK_META_KEY,
  UNJUDGED_DISCLOSURE_META_KEY,
  UNJUDGED_BLOCK_DISCLOSURE,
} from "./multimedia-content.js";
export { ReviewService } from "./review-service.js";
export type { ReviewServiceDeps, RecheckRejectionReason } from "./review-service.js";
export {
  IdempotencyConflictError,
  JobNotFoundError,
  JobExpiredError,
  InsufficientScopeError,
  RecheckRejectedError,
  RecheckThrottledError,
} from "./review-service.js";
export {
  DEFAULT_RECHECK_LIMITS,
  RecheckLimiter,
} from "./rate-limit.js";
export type {
  RecheckLimitConfig,
  ThrottleKind,
  ThrottleDecision,
} from "./rate-limit.js";
export { MockEngineClient, MockEngineJobClient } from "./engine-client.js";
export type {
  EngineClient,
  EngineJobClient,
  EngineJobPoll,
  EngineRecheckRequest,
  EngineCancelAck,
} from "./engine-client.js";
export {
  InMemoryReviewApplicationStore,
} from "./application-store.js";
export { PostgresReviewApplicationStore } from "./postgres-store.js";
export type { SqlConnection, SqlConnectionFactory, SqlResult } from "./postgres-store.js";
export type {
  ApplicationJobRecord,
  ReserveJobResult,
  ReviewApplicationStore,
} from "./application-store.js";
export { JudgmentEngineHttpClient, EngineDependencyError } from "./engine-http-client.js";
export type { EngineHttpClientOptions } from "./engine-http-client.js";
export {
  ENGINE_CANCEL_MAPPING_VERSION,
  ENGINE_CANCELED_ERROR,
  isTerminalStatus,
  mapEngineStatusToMcp,
} from "./engine-cancel.js";
export type { EnginePollStatus, MappedEngineStatus } from "./engine-cancel.js";
export {
  authenticate,
  bearerToken,
  protectedResourceMetadata,
  tenantOf,
  wwwAuthenticate,
  REVIEWS_CANCEL_SCOPE,
  TokenInvalidError,
} from "./auth.js";
export type { Principal, TokenVerifier } from "./auth.js";
export { createProductionHttpServer } from "./http-server.js";
export type { AllowlistResolver, ProductionHttpConfig } from "./http-server.js";
export { createJwtVerifier } from "./jwt-verifier.js";
export type { JwtVerifierConfig } from "./jwt-verifier.js";
export { mapEngineResultToCritique } from "./critique-map.js";
export { mapEngineRecheckToRecheck } from "./recheck-map.js";
export {
  NormalizationError,
  normalizePreviewUrl,
  normalizeReviewRequest,
  requestFingerprint,
} from "./normalize.js";
export type {
  DesignReviewInput,
  DesignRecheckInput,
  NormalizedReviewRequest,
  ReviewDepth,
  ResponseMode,
} from "./normalize.js";
export {
  classifyAddress,
  isAddressAllowed,
  isLoopbackHost,
} from "./egress.js";
export type { EgressVerdict, ProhibitedReason } from "./egress.js";
export {
  authorizeTarget,
  canonicalizeTarget,
  isHostVerified,
  TargetAuthError,
} from "./target-auth.js";
export type {
  CanonicalTarget,
  DnsResolver,
  TargetAuthFailureReason,
  TenantAllowlist,
  VerifiedTarget,
} from "./target-auth.js";
export {
  designReviewInputShape,
  designReviewGetInputShape,
  designRecheckInputShape,
  designReviewPanelActionInputShape,
  designReviewInputSchema,
  designReviewGetInputSchema,
  designRecheckInputSchema,
  designReviewPanelActionInputSchema,
} from "./tools.js";
export type {
  DesignReviewToolInput,
  DesignReviewGetToolInput,
  DesignRecheckToolInput,
  DesignReviewPanelActionToolInput,
} from "./tools.js";
// The published contract: schemas/mcp-tools.json served verbatim on the wire, so
// tools/list carries the catalog's own inputSchema and outputSchema per tool.
export {
  advertiseCatalogSchemas,
  catalogInputSchema,
  catalogOutputSchema,
  TOOL_CATALOG_PATH,
  TOOL_CATALOG_VERSION,
} from "./tool-catalog.js";
export type { JsonSchemaDocument, ToolListing, ToolListingMetadata } from "./tool-catalog.js";
export { PgPoolConnectionFactory, runMcpMigrations, MCP_MIGRATIONS_DIR } from "./pg.js";
export { PostgresAllowlistResolver, SystemDnsResolver } from "./production-adapters.js";
export { bootProduction } from "./production.js";
export type { ProductionOverrides, ProductionHandle } from "./production.js";
// Idea #64: pure reducer for the interactive MCP-Apps review panel. It maps a panel
// action (apply-fix / recheck) to the host response, eyes-not-hands preserved.
export { handlePanelAction } from "./panel-interaction.js";
// Idea #64: the review-side producer, which projects a review's fix plan (structural
// AxisFixItems) into the PanelFindings the panel renders and the reducer consumes.
export {
  toPanelFinding,
  buildPanelFindings,
  reviewFixItemsFromCritique,
  type ReviewFixItem,
} from "./panel-findings.js";
