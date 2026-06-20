# Apature MCP Review Contracts

Created: 2026-06-18
Status: proposed cross-repo contract

## 1. Contract Rules

- JSON field names use `snake_case` at external boundaries.
- IDs are opaque strings and must not encode tenant data.
- timestamps are RFC 3339 UTC strings.
- schemas evolve additive-only within a major version.
- unknown enum values must be handled as unsupported, not silently coerced.
- every result includes `schema_version`.
- every job/result read is authorized from the credential-derived tenant.
- page-derived strings carry an untrusted-content marker when returned.
- text content is a concise rendering of `structuredContent`; structured content is canonical.
- tool `outputSchema` describes successful `structuredContent`.
- expected tool failures omit `structuredContent` and return `isError: true` with text JSON conforming to the review-error schema.

## 2. MCP Tool Catalog

The authoritative machine-readable fixture is [schemas/mcp-tools.json](schemas/mcp-tools.json).

### 2.1 `design_review`

Example input:

```json
{
  "url": "https://pr-418.example-preview.com/settings",
  "routes": ["/settings", "/settings/billing"],
  "viewports": ["mobile", "desktop"],
  "depth": "deep",
  "expected_revision": "4a3f8e0",
  "response_mode": "compact",
  "client_request_id": "018ff255-bf91-7c35-b6ac-091cf68a95c1"
}
```

Example accepted output:

```json
{
  "schema_version": "1.0.0",
  "job": {
    "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
    "status": "queued",
    "kind": "review",
    "stage": "waiting_for_capacity",
    "created_at": "2026-06-18T15:04:05Z",
    "poll_after_ms": 5000,
    "expires_at": "2026-06-19T15:04:05Z",
    "reused": false
  },
  "budget": {
    "policy_version": "review-units-2026-06-18",
    "units_reserved": 12,
    "tenant_units_remaining": 188,
    "repo_units_remaining_hour": 48
  }
}
```

### 2.2 `design_review_get`

Summary input:

```json
{
  "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
  "view": "summary"
}
```

Completed summary output:

```json
{
  "schema_version": "1.0.0",
  "job": {
    "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
    "status": "completed",
    "kind": "review",
    "created_at": "2026-06-18T15:04:05Z",
    "completed_at": "2026-06-18T15:05:21Z",
    "poll_after_ms": 0,
    "expires_at": "2026-06-19T15:04:05Z",
    "reused": false
  },
  "review": {
    "review_id": "rev_01J0R5QMH01M3Y3H40G7MCR4AZ",
    "grade": "needs_work",
    "confidence": 0.91,
    "overall": "Two design-system violations should be fixed before CI.",
    "coverage": {
      "requested_routes": 2,
      "reviewed_routes": 2,
      "requested_viewports": 2,
      "reviewed_viewports": 2,
      "not_reviewed": []
    },
    "finding_counts": {
      "blocker": 0,
      "should_fix": 2,
      "nit": 1
    },
    "finding_index": [
      {
        "finding_id": "fnd_01J0R5QMS0FA32VWE7R3BPGG48",
        "severity": "should_fix",
        "dimension": "system_conformance",
        "title": "Primary CTA bypasses the approved button component",
        "route": "/settings/billing",
        "viewport": "desktop",
        "element_ref": "el_4c748b",
        "confidence": 0.96
      }
    ],
    "next_recommended_view": {
      "view": "focus",
      "finding_ids": ["fnd_01J0R5QMS0FA32VWE7R3BPGG48"]
    },
    "target": {
      "canonical_url": "https://pr-418.example-preview.com",
      "fingerprint": "sha256:dd2faad0...",
      "expected_revision": "4a3f8e0",
      "observed_revision": "4a3f8e0"
    },
    "versions": {
      "capture": "capture-3",
      "context": "context-4",
      "prompt": "review-rubric-8",
      "model": "qwen3-vl-plus",
      "ui_dna": "dna_01J0M4",
      "ui_graph": "ui-graph-2",
      "engine": "judgment-engine-0.4"
    }
  },
  "budget": {
    "policy_version": "review-units-2026-06-18",
    "units_reserved": 12,
    "units_consumed": 11,
    "tenant_units_remaining": 189,
    "repo_units_remaining_hour": 49
  }
}
```

Focused input:

```json
{
  "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
  "view": "focus",
  "finding_ids": ["fnd_01J0R5QMS0FA32VWE7R3BPGG48"],
  "evidence_mode": "refs"
}
```

Focused output:

```json
{
  "schema_version": "1.0.0",
  "job": {
    "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
    "status": "completed",
    "kind": "review",
    "created_at": "2026-06-18T15:04:05Z",
    "completed_at": "2026-06-18T15:05:21Z",
    "poll_after_ms": 0,
    "expires_at": "2026-06-19T15:04:05Z",
    "reused": false
  },
  "focus": {
    "review_id": "rev_01J0R5QMH01M3Y3H40G7MCR4AZ",
    "findings": [
      {
        "finding_id": "fnd_01J0R5QMS0FA32VWE7R3BPGG48",
        "severity": "should_fix",
        "dimension": "system_conformance",
        "title": "Primary CTA bypasses the approved button component",
        "observation": "The visible CTA uses a one-off purple fill and radius instead of the approved primary button.",
        "standard": {
          "rule": "Use the approved primary button component and primary-600 token.",
          "source": "ui_dna",
          "source_id": "rule_button_primary",
          "confidence": 0.99
        },
        "route": "/settings/billing",
        "viewport": "desktop",
        "element_ref": "el_4c748b",
        "repair_hint": {
          "intent": "Replace the one-off CTA styling with the canonical primary button.",
          "likely_location": {
            "component": "BillingActions",
            "selector_hash": "sha256:b933...",
            "source_hint": "Search for the Upgrade button label and its local class list.",
            "confidence": 0.78
          },
          "recommended_change": {
            "kind": "component",
            "from": "local button markup with bg-[#6c3ef0]",
            "to": "approved Button variant=primary",
            "constraint": "Preserve the label and action while using the approved component and token."
          },
          "expected_visible_result": "The CTA matches canonical color, radius, type, and hover treatment.",
          "verification": "Recheck passes when rendered style facts and UI DNA component mapping match the approved primary button.",
          "patch_provided": false
        },
        "evidence_refs": ["ev_annotated_01J0R5", "ev_style_01J0R6"],
        "untrusted_content": false,
        "confidence": 0.96
      }
    ],
    "graph_view": {
      "view": "focus",
      "included_nodes": 12,
      "included_edges": 18,
      "estimated_tokens": 740,
      "truncated": false
    }
  }
}
```

### 2.3 `design_recheck`

Example input:

```json
{
  "review_id": "rev_01J0R5QMH01M3Y3H40G7MCR4AZ",
  "finding_ids": ["fnd_01J0R5QMS0FA32VWE7R3BPGG48"],
  "expected_revision": "7b61c24",
  "client_request_id": "018ff265-d4dd-77f5-a0da-774aa665df2a"
}
```

Recheck result:

```json
{
  "schema_version": "1.0.0",
  "job": {
    "job_id": "job_01J0R6FDDW8QWD7P4F99K10WD1",
    "status": "completed",
    "kind": "recheck",
    "created_at": "2026-06-18T15:11:01Z",
    "completed_at": "2026-06-18T15:11:28Z",
    "poll_after_ms": 0,
    "expires_at": "2026-06-19T15:11:01Z",
    "reused": false
  },
  "recheck": {
    "recheck_id": "rck_01J0R6G9V8XV0D8W0E5DG5M5B1",
    "review_id": "rev_01J0R5QMH01M3Y3H40G7MCR4AZ",
    "before_fingerprint": "sha256:dd2faad0...",
    "after_fingerprint": "sha256:12a44d09...",
    "capture_scope": "focused",
    "outcomes": [
      {
        "finding_id": "fnd_01J0R5QMS0FA32VWE7R3BPGG48",
        "outcome": "passed",
        "confidence": 0.97,
        "reason": "The CTA now maps to the approved primary component and token.",
        "before_evidence_refs": ["ev_annotated_01J0R5"],
        "after_evidence_refs": ["ev_annotated_01J0R7"]
      }
    ]
  },
  "budget": {
    "policy_version": "review-units-2026-06-18",
    "units_reserved": 1,
    "units_consumed": 1,
    "tenant_units_remaining": 188,
    "repo_units_remaining_hour": 48
  }
}
```

### 2.4 `design_review_cancel`

Example output:

```json
{
  "schema_version": "1.0.0",
  "job_id": "job_01J0R5N8GCZKJQGT1T6P6Y6X25",
  "status": "cancelled",
  "cancellation_requested_at": "2026-06-18T15:04:20Z",
  "upstream_cancellation": "requested"
}
```

## 3. Error Contract

The normative schema is [schemas/review-error.schema.json](schemas/review-error.schema.json).

Expected product failures are tool execution errors:

```json
{
  "schema_version": "1.0.0",
  "code": "DOMAIN_UNVERIFIED",
  "message": "This preview host is not authorized for the current tenant.",
  "retriable": false,
  "correlation_id": "corr_01J0R4",
  "next_action": "verify_domain",
  "details": {
    "host": "pr-418.example-preview.com",
    "supported_methods": ["gate_provenance", "provider_project", "dns", "http"]
  }
}
```

The MCP result sets `isError: true`, places compact serialized JSON in a text content block, and omits `structuredContent`. This keeps the error machine-readable without violating the tool's success-only `outputSchema`.

Rate error:

```json
{
  "schema_version": "1.0.0",
  "code": "RATE_LIMITED",
  "message": "The repository review rate is temporarily exhausted.",
  "retriable": true,
  "retry_after_ms": 18000,
  "stage": "budget_reservation",
  "correlation_id": "corr_01J0R8",
  "next_action": "wait",
  "details": {
    "limit": "repo_units_per_hour",
    "reset_at": "2026-06-18T16:00:00Z"
  }
}
```

## 4. MCP Review to Judgment Engine

### 4.1 Submit request

```ts
type McpReviewEngineRequest = {
  contractVersion: "1";
  product: "mcp_review";
  tenant: {
    tenantId: string;
    installationId: string;
    repositoryId?: string;
  };
  request: {
    productJobId: string;
    idempotencyKey: string;
    kind: "review" | "recheck";
    deadlineAt: string;
  };
  target: {
    canonicalUrl: string;
    authorizedHosts: string[];
    authorizationProofRef: string;
    expectedRevision?: string;
  };
  scope: {
    routes: string[];
    viewports: Array<"mobile" | "tablet" | "desktop">;
    depth: "triage" | "deep";
  };
  recheck?: {
    reviewId: string;
    findingIds: string[];
    beforeFingerprint: string;
  };
  output: {
    resultSchemaVersion: "1.0.0";
    retainUiGraphForViews: boolean;
  };
};
```

Beta requires a Gate installation, so the existing Judgment Engine `installationId` quota and isolation seam remains valid. Dashboard-only MCP onboarding is deferred until Judgment Engine accepts a tenant-scoped workload principal without a synthetic GitHub installation.

### 4.2 Engine result

```ts
type McpReviewEngineResult = {
  contractVersion: "1";
  engineJobId: string;
  status: "queued" | "running" | "cancelling" | "completed" | "failed";
  stage?: string;
  result?: {
    review: EngineReview;
    artifacts: EngineArtifactRef[];
    uiGraphSnapshotRef?: string;
    usage: EngineUsage;
    versions: EngineVersions;
  };
  error?: EngineError;
};
```

Rules:

- MCP Review never accepts an engine result that fails schema validation.
- tenant and product job IDs must match the signed request.
- unknown element refs are absent from published findings.
- raw model output is never returned to MCP Review clients.
- engine debug URLs are internal.
- engine `cancelling` maps to product status `running` with stage `cancelling`;
- external `cancelled` is terminal only after the engine acknowledges that no late result can publish.

## 5. MCP Review to UI Graph

MCP Review does not call `ui-graph` directly. UI Graph is a deterministic package inside Judgment Engine and has no network, tenancy, storage, or artifact credentials.

Judgment Engine exposes an authenticated application operation equivalent to:

```ts
renderReviewView(reviewArtifactId, spec: UIGraphViewSpec) -> UIGraphView
getReviewEvidence(reviewArtifactId, evidenceRef) -> EvidenceArtifact
```

Required query mappings:

| MCP view | UI Graph view |
|---|---|
| `summary` | `summary` and optionally `violations` |
| `findings` | finding records plus evidence refs |
| `focus` | bounded `focus` plus `patchContext` for selected element refs |
| `evidence` | Judgment Engine evidence read |

MCP Review adds:

- tenant authorization;
- result pagination;
- retention handling;
- client-specific output limits;
- safe untrusted-content labels.

It does not change graph nodes, edges, element refs, or confidence semantics.

## 6. MCP Review to UI DNA

MCP Review does not query mutable DNA administration APIs.

Every review exposes:

```ts
type DnaLineage = {
  uiDnaVersion: string | null;
  approvalState: "approved" | "missing";
  fallbackContextUsed: boolean;
};
```

Rules:

- system-conformance findings require an approved DNA projection;
- before approved DNA exists, Judgment Engine may use deterministic raw repository context with `uiDnaVersion: null`, but must not represent it as canonical DNA;
- MCP Review never requests or exposes draft DNA;
- missing DNA is surfaced, never silently represented as canonical.

## 7. MCP Review to Gate

No synchronous dependency is required.

Shared correlation fields:

```ts
type ReviewCorrelation = {
  repositoryId?: string;
  pullRequestNumber?: number;
  headSha?: string;
  previewDeploymentId?: string;
  mcpReviewId?: string;
  gateRunId?: string;
};
```

Gate may later emit `gate_outcome_linked` feedback events. MCP Review does not post GitHub comments, update Check Runs, or mark a PR passed.

## 8. Feedback Contract

See [schemas/feedback-event.schema.json](schemas/feedback-event.schema.json).

Event semantics:

| Event class | Required identity | Label behavior |
|---|---|---|
| Job lifecycle | `job_id` | telemetry only |
| Completed review | `job_id`, `review_id` | telemetry only |
| Finding presentation/retrieval | `review_id`, `finding_id` | telemetry only |
| Declared fix attempt | `review_id`, `finding_id` | label required, training-ineligible |
| Recheck submission | `review_id`, `recheck_id` | telemetry only |
| Recheck outcome | `review_id`, `finding_id`, `recheck_id` | label and changed-target evidence required |
| Unchanged target | `review_id`, `recheck_id` | label required, training-ineligible |
| Finding rejection/ignore | `review_id`, `finding_id` | explicit or inferred label required |
| Gate linkage | `review_id`, `gate_run_id` | outcome label required |

`review_submitted` cannot require `review_id` because that identifier may not exist until the job completes. Retrieval and polling telemetry never become implicit positive labels.

High-quality recheck event:

```json
{
  "schema_version": "1.0.0",
  "event_id": "evt_01J0R6H1WQ7Y4GDXAE79H2TS51",
  "event_type": "recheck_passed",
  "occurred_at": "2026-06-18T15:11:28Z",
  "tenant_id": "ten_01HZ",
  "repository_id": "repo_01JA",
  "review_id": "rev_01J0R5QMH01M3Y3H40G7MCR4AZ",
  "finding_id": "fnd_01J0R5QMS0FA32VWE7R3BPGG48",
  "recheck_id": "rck_01J0R6G9V8XV0D8W0E5DG5M5B1",
  "actor": {
    "type": "system",
    "id": "mcp-review"
  },
  "label": {
    "source": "deterministic",
    "confidence": 0.97,
    "training_eligible": true
  },
  "target": {
    "before_fingerprint": "sha256:dd2faad0...",
    "after_fingerprint": "sha256:12a44d09...",
    "changed": true
  },
  "lineage": {
    "capture_version": "capture-3",
    "context_version": "context-4",
    "prompt_version": "review-rubric-8",
    "model_version": "qwen3-vl-plus",
    "ui_dna_version": "dna_01J0M4",
    "ui_graph_version": "ui-graph-2",
    "result_schema_version": "1.0.0"
  },
  "deduplication_key": "rck_01J0R6G9V8XV0D8W0E5DG5M5B1:fnd_01J0R5QMS0FA32VWE7R3BPGG48:passed"
}
```

## 9. Versioning

Contract versions:

- MCP tool catalog: semantic version;
- tool input/output schema: semantic version;
- MCP Review/Engine contract: integer major plus additive minor fields;
- feedback event schema: semantic version;
- review-unit policy: date/version identifier.

Breaking change examples:

- removing or renaming a field;
- changing an enum meaning;
- changing ID scope;
- making an optional field required;
- changing tool semantics from async to blocking.

Non-breaking examples:

- adding an optional field;
- adding a new error code when clients handle unknown codes safely;
- adding a running stage;
- adding an evidence type;
- adding a new `design_review_get` view only when unknown views remain invalid.

## 10. Golden Fixtures

Before implementation, create fixtures for:

- accepted review;
- reused idempotent review;
- status in every running stage;
- completed compact summary;
- findings pagination;
- focus view;
- evidence ref and expired evidence tombstone;
- passed, failed, and inconclusive rechecks;
- cancellation;
- every non-internal error code;
- protocol-valid `isError` results with no success `structuredContent`;
- lifecycle feedback without labels and outcome feedback with labels;
- missing UI DNA degradation;
- missing UI Graph degradation;
- prompt-injection content marked untrusted;
- shared-provider domain rejection;
- cross-tenant job-read rejection.
