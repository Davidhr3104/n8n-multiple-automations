-- Esquema de la fundación. Postgres estándar: se puede pegar tal cual en el SQL editor de Supabase.
-- Idempotente (IF NOT EXISTS / OR REPLACE): deploy.ps1 lo vuelve a ejecutar en cada deploy.

-- Un registro por paso de cada ejecución de cualquier automatización.
CREATE TABLE IF NOT EXISTS execution_log (
  id          bigserial PRIMARY KEY,
  run_id      text        NOT NULL,           -- id de ejecución de n8n
  workflow    text        NOT NULL,           -- p.ej. 'lead-intake'
  entity_id   text,                           -- lead_id, ticket_id, sku...
  step        text        NOT NULL,           -- p.ej. 'rules_scored'
  status      text        NOT NULL,           -- ok | failed | skipped | duplicate | waiting
  error       text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_log_entity_idx   ON execution_log (workflow, entity_id, created_at);
CREATE INDEX IF NOT EXISTS execution_log_run_idx      ON execution_log (run_id);
CREATE INDEX IF NOT EXISTS execution_log_failed_idx   ON execution_log (created_at) WHERE status = 'failed';

-- Claves de idempotencia: la PRIMARY KEY hace el "reclamo" atómico (sin carreras entre webhooks simultáneos).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          text PRIMARY KEY,
  workflow     text        NOT NULL,
  execution_id text,
  status       text        NOT NULL DEFAULT 'processing',  -- processing | done | failed
  attempts     integer     NOT NULL DEFAULT 1,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  result       jsonb
);

-- Vistas para el panel de métricas.
CREATE OR REPLACE VIEW v_run_summary AS
SELECT run_id, workflow, entity_id,
       min(created_at)                                  AS started_at,
       max(created_at)                                  AS last_event_at,
       count(*)                                         AS steps,
       bool_or(status = 'failed')                       AS had_failure,
       (array_agg(step ORDER BY id DESC))[1]            AS last_step,
       (array_agg(status ORDER BY id DESC))[1]          AS last_status
FROM execution_log
GROUP BY run_id, workflow, entity_id;

CREATE OR REPLACE VIEW v_daily_metrics AS
SELECT date_trunc('day', created_at)::date AS day,
       workflow,
       count(DISTINCT run_id)                                         AS runs,
       count(DISTINCT run_id) FILTER (WHERE status = 'failed')        AS runs_with_failures,
       count(*)           FILTER (WHERE status = 'duplicate')         AS duplicates_blocked,
       count(*)           FILTER (WHERE step = 'human_decision')      AS human_reviews
FROM execution_log
GROUP BY 1, 2;
