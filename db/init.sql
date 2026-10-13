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

-- ───────────── #5 Calificación de leads + reporte semanal ─────────────
-- Round-robin atómico: nextval() no tiene carreras entre leads simultáneos.
CREATE SEQUENCE IF NOT EXISTS rep_rr_seq;

-- Un resultado por lead (alimenta el reporte semanal). Contiene PII (email, nombre): aplicar retención/RLS en producción.
CREATE TABLE IF NOT EXISTS lead_outcomes (
  lead_id         text PRIMARY KEY,
  received_at     timestamptz NOT NULL,
  email           text,
  name            text,
  company         text,
  source          text,
  industry        text,
  tier            text,
  score           integer,
  status          text        NOT NULL,   -- auto_processed | approved_by_human | rejected_by_human | no_human_response | rejected_invalid | duplicate_skipped | crm_failed
  needs_human     boolean     NOT NULL DEFAULT false,
  rep_email       text,
  outreach_status text,                   -- sent | rep_rejected | rep_no_response | skipped | send_failed
  execution_id    text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_outcomes_received_idx ON lead_outcomes (received_at);

-- ───────────── #1 Revival de leads ─────────────
-- Normaliza teléfonos igual que lib/revival.js (para cruzar contra la lista de bajas).
CREATE OR REPLACE FUNCTION norm_phone(p text, cc text DEFAULT '57') RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR length(regexp_replace(p, '[^0-9]', '', 'g')) < 8 THEN NULL
              WHEN btrim(p) LIKE '+%' THEN '+' || regexp_replace(p, '[^0-9]', '', 'g')
              WHEN length(regexp_replace(p, '[^0-9]', '', 'g')) >= 11 THEN '+' || regexp_replace(p, '[^0-9]', '', 'g')
              ELSE '+' || cc || regexp_replace(p, '[^0-9]', '', 'g') END
$$;

-- Espejo del CRM (mock de GHL). En modo live los contactos vienen de la API de GHL.
CREATE TABLE IF NOT EXISTS revival_contacts (
  contact_id       text PRIMARY KEY,
  name             text        NOT NULL,
  email            text,
  phone            text,
  company          text,
  last_activity_at timestamptz NOT NULL,
  history          jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- notas del CRM: dato NO confiable
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Lista de bajas: se consulta en la selección Y otra vez justo antes de cada envío. Nunca se borra desde los flujos.
CREATE TABLE IF NOT EXISTS suppression_list (
  key         text PRIMARY KEY,          -- email en minúsculas o teléfono normalizado (+57...)
  reason      text        NOT NULL,
  contact_id  text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un lote por corrida diaria: nada se envía sin un lote 'approved'.
CREATE TABLE IF NOT EXISTS revival_batches (
  batch_id     text PRIMARY KEY,
  status       text        NOT NULL,     -- pending_approval | approved | rejected | no_response | dispatched
  size         integer     NOT NULL,
  execution_id text,
  summary      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

-- Estado de la secuencia por contacto.
CREATE TABLE IF NOT EXISTS revival_state (
  contact_id          text PRIMARY KEY,
  status              text        NOT NULL,   -- active | completed | opted_out | not_interested | booking_sent | needs_review
  step                integer     NOT NULL DEFAULT 0,
  next_touch_at       timestamptz,
  batch_id            text,
  last_classification text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revival_state_due_idx ON revival_state (next_touch_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS revival_messages (
  id             bigserial PRIMARY KEY,
  contact_id     text        NOT NULL,
  direction      text        NOT NULL DEFAULT 'out',   -- out | in
  touch          integer,
  channel        text        NOT NULL,
  body           text        NOT NULL,
  status         text        NOT NULL,                 -- sent | blocked | received | booking_sent
  classification text,
  batch_id       text,
  execution_id   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revival_messages_contact_idx ON revival_messages (contact_id, created_at);

-- Mock de los custom fields de GHL (en live se actualizan por API).
CREATE TABLE IF NOT EXISTS revival_custom_fields (
  contact_id text NOT NULL,
  field      text NOT NULL,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, field)
);

CREATE OR REPLACE VIEW v_revival_funnel AS
SELECT status, count(*) AS contacts FROM revival_state GROUP BY status;
