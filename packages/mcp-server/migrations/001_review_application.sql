CREATE TABLE IF NOT EXISTS mcp_review_jobs (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  principal_id text NOT NULL,
  client_request_id text NOT NULL,
  normalized_request_hash text NOT NULL,
  engine_job_id text,
  status text NOT NULL,
  record jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS mcp_review_jobs_expiry
  ON mcp_review_jobs (expires_at);

-- Production roles must also enable RLS and bind app.tenant_id per transaction.
ALTER TABLE mcp_review_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_review_jobs_tenant_isolation ON mcp_review_jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
