import type {
  EngineDimension,
  EngineFinding,
  EngineGrade,
  EngineReviewResult,
  EngineSeverity,
  EngineViewport,
} from "@apature/mcp-types";

/**
 * Structural validation of an `EngineReviewResult` that arrived from outside
 * this process.
 *
 * The fixture engine loads a golden file this repository owns, so nothing there
 * can surprise the mapper. A real backend (`verdict`, over its CLI or its job
 * API) is a separate program on a separate release train, and a result that is
 * a version ahead, truncated, or simply an error page parsed as JSON must fail
 * loudly at the boundary rather than reach `mapEngineResultToCritique` and
 * surface as `undefined` in an agent-facing finding.
 *
 * This is a shape check, not a judgment check: it proves the payload is the
 * contract in `@apature/mcp-types`, and says nothing about whether a model
 * produced it. Fields the type marks optional (confidence, calibration,
 * dimension) are validated only when present, so a backend that omits them
 * stays compatible.
 */

export class EngineResultError extends Error {
  constructor(
    message: string,
    /** Where the payload came from, e.g. the file or URL it was read from. */
    readonly source: string,
  ) {
    super(`${message} (from ${source})`);
    this.name = "EngineResultError";
  }
}

const GRADES: readonly EngineGrade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];
const SEVERITIES: readonly EngineSeverity[] = ["nit", "minor", "major", "blocker"];
const VIEWPORTS: readonly EngineViewport[] = ["mobile", "tablet", "desktop"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(source: string, message: string): never {
  throw new EngineResultError(message, source);
}

function requireString(source: string, value: unknown, path: string): string {
  if (typeof value !== "string") fail(source, `${path} must be a string`);
  return value;
}

function requireNullableString(source: string, value: unknown, path: string): string | null {
  if (value === null) return null;
  return requireString(source, value, path);
}

function requireOneOf<T extends string>(
  source: string,
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(source, `${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireArray(source: string, value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(source, `${path} must be an array`);
  return value;
}

/** Validate an optional 0..1 confidence, returning undefined when absent. */
function optionalUnitInterval(source: string, value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(source, `${path} must be a number in [0, 1]`);
  }
  return value;
}

function parseFinding(source: string, value: unknown, index: number): EngineFinding {
  const path = `findings[${index}]`;
  if (!isRecord(value)) fail(source, `${path} must be an object`);
  const confidence = optionalUnitInterval(source, value.confidence, `${path}.confidence`);
  return {
    // Spread first, for the same reason the result does: a field this validator
    // has never heard of belongs to the engine, and dropping it would silently
    // downgrade a newer backend.
    ...value,
    id: requireString(source, value.id, `${path}.id`),
    severity: requireOneOf(source, value.severity, SEVERITIES, `${path}.severity`),
    // The rubric dimension is checked as a string, not against the known eight:
    // the engine owns that vocabulary and may extend it additively, and failing
    // a whole review closed over an unrecognized dimension would reject a
    // result that is otherwise entirely valid.
    ...(value.dimension === undefined
      ? {}
      : {
          dimension: requireString(
            source,
            value.dimension,
            `${path}.dimension`,
          ) as EngineDimension,
        }),
    title: requireString(source, value.title, `${path}.title`),
    description: requireString(source, value.description, `${path}.description`),
    route: requireString(source, value.route, `${path}.route`),
    viewport: requireOneOf(source, value.viewport, VIEWPORTS, `${path}.viewport`),
    element: requireNullableString(source, value.element, `${path}.element`),
    screenshotId: requireNullableString(source, value.screenshotId, `${path}.screenshotId`),
    suggestion: requireNullableString(source, value.suggestion, `${path}.suggestion`),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

/**
 * Parse and validate an engine result. Throws `EngineResultError` naming the
 * exact field that failed, so a backend mismatch is diagnosable from one log
 * line instead of a downstream `undefined`.
 *
 * Unknown extra fields are preserved: the engine owns this contract and may add
 * to it additively, and dropping what we do not recognize would silently
 * downgrade a newer backend.
 */
export function parseEngineReviewResult(value: unknown, source: string): EngineReviewResult {
  if (!isRecord(value)) fail(source, "engine result must be a JSON object");

  const artifacts = value.artifacts;
  if (!isRecord(artifacts)) fail(source, "artifacts must be an object");
  const screenshots = requireArray(source, artifacts.annotatedScreenshots, "artifacts.annotatedScreenshots");
  screenshots.forEach((shot, index) => {
    const path = `artifacts.annotatedScreenshots[${index}]`;
    if (!isRecord(shot)) fail(source, `${path} must be an object`);
    requireString(source, shot.findingId, `${path}.findingId`);
    requireString(source, shot.url, `${path}.url`);
  });

  const metadata = value.metadata;
  if (!isRecord(metadata)) fail(source, "metadata must be an object");

  const retention = value.screenshotRetentionSeconds;
  if (typeof retention !== "number" || !Number.isFinite(retention) || retention < 0) {
    fail(source, "screenshotRetentionSeconds must be a non-negative number");
  }

  const findings = requireArray(source, value.findings, "findings").map((finding, index) =>
    parseFinding(source, finding, index),
  );
  const notReviewed = requireArray(source, value.notReviewed, "notReviewed").map((entry, index) =>
    requireString(source, entry, `notReviewed[${index}]`),
  );

  return {
    ...value,
    grade: requireOneOf(source, value.grade, GRADES, "grade"),
    overall: requireString(source, value.overall, "overall"),
    findings,
    notReviewed,
    artifacts: {
      ...artifacts,
      annotatedScreenshots: screenshots as EngineReviewResult["artifacts"]["annotatedScreenshots"],
    },
    screenshotRetentionSeconds: retention,
    metadata: {
      ...metadata,
      engineVersion: requireString(source, metadata.engineVersion, "metadata.engineVersion"),
      model: requireString(source, metadata.model, "metadata.model"),
      promptVersion: requireString(source, metadata.promptVersion, "metadata.promptVersion"),
      captureVersion: requireString(source, metadata.captureVersion, "metadata.captureVersion"),
      uiDnaVersion: requireNullableString(source, metadata.uiDnaVersion, "metadata.uiDnaVersion"),
    },
  };
}
