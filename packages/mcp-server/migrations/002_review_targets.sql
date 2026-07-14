-- Ownership-verified target registry (#36; TRD §7.2, THREAT_MODEL T1/T2).
-- The production AllowlistResolver reads only rows whose ownership verification
-- completed; how a row gets verified (DNS TXT, GitHub deployment linkage,
-- provider project binding) is recorded but enforced upstream at registration.
CREATE TABLE IF NOT EXISTS mcp_review_targets (
  tenant_id   text NOT NULL,
  host        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('host', 'github_deployment', 'provider_project')),
  verified_at timestamptz,
  verification_method text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, host)
);

ALTER TABLE mcp_review_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_review_targets_tenant_isolation ON mcp_review_targets
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
