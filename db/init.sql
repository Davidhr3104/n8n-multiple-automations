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

-- ───────────── Revival v2: revisión por lead + horario de envío ─────────────
-- Zona horaria IANA del contacto (opcional). Si falta se deduce del prefijo del teléfono o se usa la de por defecto.
ALTER TABLE revival_contacts ADD COLUMN IF NOT EXISTS timezone text;

-- El lote ahora se REVISA (página con token) en lugar de aprobarse a ciegas por email.
-- status: preparing | pending_review | approved | rejected | expired | dispatched (histórico)
ALTER TABLE revival_batches ADD COLUMN IF NOT EXISTS review_token text;
ALTER TABLE revival_batches ADD COLUMN IF NOT EXISTS expires_at   timestamptz;

-- Un borrador por contacto y toque: el texto REAL que el dueño ve, edita, envía o salta.
CREATE TABLE IF NOT EXISTS revival_drafts (
  id             bigserial PRIMARY KEY,
  batch_id       text        NOT NULL,
  contact_id     text        NOT NULL,
  touch          integer     NOT NULL,
  kind           text        NOT NULL DEFAULT 'new',     -- new | follow_up
  status         text        NOT NULL,                   -- pending_review | approved | skipped | blocked | failed | deferred | sent
  body_core      text,                                   -- texto editable (sin el pie de baja)
  body           text,                                   -- texto final que se envía (con pie de baja)
  original_body  text,                                   -- lo que generó la IA, para medir cuánto edita el dueño
  edited         boolean     NOT NULL DEFAULT false,
  reason         text,                                   -- por qué está blocked/failed/skipped
  tz             text,
  tz_source      text,                                   -- contact | phone | default
  send_after     timestamptz,                            -- si está diferido por horario: cuándo abre la ventana
  execution_id   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  sent_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS revival_drafts_unique_idx ON revival_drafts (batch_id, contact_id, touch);
CREATE INDEX IF NOT EXISTS revival_drafts_status_idx ON revival_drafts (status, send_after);

-- ───────────── #6 Conversational Qualifier + Booking ─────────────
-- Una fila por conversación. locked_until = bloqueo por contacto: dos mensajes seguidos del mismo lead nunca se procesan a la vez.
CREATE TABLE IF NOT EXISTS conversation_state (
  contact_id        text PRIMARY KEY,
  status            text        NOT NULL DEFAULT 'active',      -- active | qualified | booked | disqualified | handoff | stale | dnc
  step              text        NOT NULL DEFAULT 'qualifying',  -- qualifying | booking
  answers           jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{criterion, value, evidence}] con cita textual
  offered_slots     jsonb,
  attempts          integer     NOT NULL DEFAULT 0,
  booking_attempts  integer     NOT NULL DEFAULT 0,
  pending_criterion text,
  name              text,
  phone             text,
  email             text,
  timezone          text,
  handoff_reason    text,
  disqualify_reason text,
  followup_sent_at  timestamptz,
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  locked_until      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages_log (
  id           bigserial PRIMARY KEY,
  message_id   text UNIQUE,                 -- entrantes: id de GHL; salientes: 'out:<outbox_id>'
  contact_id   text        NOT NULL,
  direction    text        NOT NULL,        -- in | out
  body         text        NOT NULL,
  llm_output   jsonb,
  execution_id text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_log_contact_idx ON messages_log (contact_id, created_at);

-- Cola de salida: todo mensaje del bot pasa por aquí y se envía respetando el horario local del lead.
CREATE TABLE IF NOT EXISTS qualifier_outbox (
  id           bigserial PRIMARY KEY,
  contact_id   text        NOT NULL,
  kind         text        NOT NULL,        -- question | booking_offer | confirmation | close | followup
  body         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',   -- pending | sent | failed | blocked
  reason       text,
  tz           text,
  tz_source    text,
  send_after   timestamptz NOT NULL DEFAULT now(),
  execution_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX IF NOT EXISTS qualifier_outbox_due_idx ON qualifier_outbox (status, send_after);

CREATE TABLE IF NOT EXISTS bookings (
  id             bigserial PRIMARY KEY,
  contact_id     text        NOT NULL,
  appointment_id text        NOT NULL,
  slot_start     timestamptz NOT NULL,
  rep            text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- El índice único es lo que decide una carrera por el mismo horario (mock del calendario de GHL).
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot_unique_idx ON bookings (slot_start);

-- Horarios ya ocupados en el calendario simulado (para probar conflictos).
CREATE TABLE IF NOT EXISTS mock_calendar_busy (slot_start timestamptz PRIMARY KEY);

-- ───────────── Support Reply Agent ─────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id     text PRIMARY KEY,
  from_email    text        NOT NULL,
  from_name     text,
  subject       text,
  body          text        NOT NULL,
  thread_id     text,
  message_id    text,
  status        text        NOT NULL,   -- received | ignored | escalated | pending_review | auto_replied | approved_sent | rejected | no_response | failed
  intent        text,
  sentiment     text,
  action        text,                   -- ignore | escalate | review | auto
  reasons       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_similarity numeric,
  confidence    numeric,
  sources       jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- fragmentos recuperados: id, doc, título, similitud
  citations     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  reply_text    text,
  execution_id  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  replied_at    timestamptz
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, created_at);

-- ───────────── CRM ↔ Sheets Sync ─────────────
-- Adaptadores MOCK: en local estas dos tablas hacen de CRM y de hoja de cálculo. Los adaptadores live NO existen (SYNC_MODE=live falla ruidosamente).
-- updated_at = última modificación HECHA POR UNA PERSONA (el sync no la toca): sirve de guarda contra carreras al escribir.
CREATE TABLE IF NOT EXISTS sync_crm_contacts (
  id         text PRIMARY KEY,
  name       text,
  email      text,
  phone      text,
  company    text,
  stage      text,
  merged_into text,                         -- marcado como duplicado de otro registro (NUNCA se borra)
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_sheet_rows (
  id         text PRIMARY KEY,
  name       text,
  email      text,
  phone      text,
  company    text,
  stage      text,
  duplicate_of text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
-- Vínculo CRM <-> fila. `base` = último valor sincronizado por campo (forma canónica): permite la fusión de tres vías.
CREATE TABLE IF NOT EXISTS sync_links (
  link_id    bigserial PRIMARY KEY,
  crm_id     text NOT NULL UNIQUE,
  sheet_id   text NOT NULL UNIQUE,
  base       jsonb NOT NULL DEFAULT '{}'::jsonb,
  how        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Conflicto = los dos lados cambiaron el mismo campo a valores distintos. No se toca ninguno hasta que una persona decide.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id               bigserial PRIMARY KEY,
  crm_id           text NOT NULL,
  sheet_id         text NOT NULL,
  field            text NOT NULL,
  crm_value        text,
  sheet_value      text,
  base_value       text,
  crm_updated_at   timestamptz(3),
  sheet_updated_at timestamptz(3),
  status           text NOT NULL DEFAULT 'open',   -- open | resolved | resolved_auto (los valores convergieron solos)
  resolution       text,                           -- crm | sheet
  run_id           text,
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_conflicts_open_uidx ON sync_conflicts (crm_id, sheet_id, field) WHERE status = 'open';
-- Incidencias que requieren ojos humanos (inválidos, posibles duplicados, vínculos huérfanos, campos vaciados). La clave evita avisar dos veces.
CREATE TABLE IF NOT EXISTS sync_issues (
  key         text PRIMARY KEY,
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id      text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- Historial de cada cambio hecho por el sync (qué, dónde, antes y después).
CREATE TABLE IF NOT EXISTS sync_changes (
  id         bigserial PRIMARY KEY,
  run_id     text NOT NULL,
  side       text NOT NULL,
  action     text NOT NULL,       -- create | update | mark_duplicate | resolve_conflict
  entity_id  text NOT NULL,
  field      text,
  old_value  text,
  new_value  text,
  source_id  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_changes_run_idx ON sync_changes (run_id);
-- Link de revisión de conflictos (token + vencimiento).
CREATE TABLE IF NOT EXISTS sync_reviews (
  review_id  text PRIMARY KEY,
  token      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
-- Aborta TODA la sentencia (y sus CTE de escritura) con un mensaje claro: así el plan se aplica entero o nada.
CREATE OR REPLACE FUNCTION sync_abort(msg text) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '%', msg; END $$;

-- ───────────── Invoice & Document Processor ─────────────
-- Maestro de proveedores (mock). La cuenta bancaria registrada es lo que se compara con la de cada factura.
CREATE TABLE IF NOT EXISTS invoice_vendors (
  vendor_key text PRIMARY KEY,           -- nombre normalizado (minúsculas, sin tildes ni signos)
  name       text NOT NULL,
  approved   boolean NOT NULL DEFAULT true,
  bank_last4 text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoices (
  doc_id           text PRIMARY KEY,
  filename         text,
  sender_email     text        NOT NULL,
  content_hash     text        NOT NULL,
  vendor_name      text,
  vendor_key       text,
  invoice_number   text,
  invoice_key      text,
  invoice_date     date,
  due_date         date,
  currency         text,
  subtotal         numeric,
  tax              numeric,
  total            numeric,
  bank_last4       text,
  line_items       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  field_confidence jsonb       NOT NULL DEFAULT '{}'::jsonb,
  evidence         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  checks           jsonb       NOT NULL DEFAULT '[]'::jsonb,      -- validaciones que fallaron
  reasons          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  action           text,                                          -- ignore | duplicate | escalate | review | auto
  status           text        NOT NULL,                          -- ignored | duplicate | escalated | auto_posted | approved_posted | rejected | no_response | failed
  confidence       numeric,
  extraction_model text,
  execution_id     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_at        timestamptz
);
CREATE INDEX IF NOT EXISTS invoices_lookup_idx ON invoices (vendor_key, invoice_key);
CREATE INDEX IF NOT EXISTS invoices_hash_idx ON invoices (content_hash);
-- Última red de seguridad contra el doble pago: la misma factura de un proveedor no se contabiliza dos veces ni en una carrera.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_posted_unique_idx ON invoices (vendor_key, invoice_key) WHERE status IN ('auto_posted', 'approved_posted') AND invoice_key <> '';
-- "Contabilidad" mock: en local esta tabla hace de Xero / Google Sheets. La integración live NO está construida.
CREATE TABLE IF NOT EXISTS invoice_ledger (
  id             bigserial PRIMARY KEY,
  doc_id         text NOT NULL UNIQUE,
  vendor_name    text NOT NULL,
  invoice_number text NOT NULL,
  invoice_date   date NOT NULL,
  due_date       date,
  currency       text NOT NULL,
  total          numeric NOT NULL,
  posted_by      text NOT NULL,   -- auto | human
  posted_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Ticket Triage + SLA Watcher ─────────────
-- Clientes por dominio del remitente (mock del CRM/helpdesk): el plan fija un PISO de prioridad que la IA no puede bajar.
CREATE TABLE IF NOT EXISTS triage_customers (
  domain     text PRIMARY KEY,
  name       text NOT NULL,
  plan       text NOT NULL CHECK (plan IN ('enterprise', 'pro', 'free')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Equipo de soporte: la asignación elige entre activos con la habilidad de la categoría y cupo libre.
CREATE TABLE IF NOT EXISTS triage_agents (
  agent_id text PRIMARY KEY,
  name     text NOT NULL,
  email    text NOT NULL,
  skills   text[]  NOT NULL DEFAULT '{}',
  max_open integer NOT NULL DEFAULT 5,
  active   boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS triage_tickets (
  ticket_id          text PRIMARY KEY,
  from_email         text        NOT NULL,
  subject            text,
  body               text,
  received_at        timestamptz(3) NOT NULL,
  plan               text,
  category           text,
  priority           text,                                  -- P1..P4 (NULL si se ignoró)
  ai_urgency         text,
  sentiment          text,
  summary            text,
  confidence         numeric,
  evidence           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reasons            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  human_triage       boolean     NOT NULL DEFAULT false,    -- una persona debe confirmar prioridad/asignación
  p1_candidate       boolean     NOT NULL DEFAULT false,
  assignee_id        text,
  assignee_email     text,
  first_response_due timestamptz(3),
  resolution_due     timestamptz(3),
  first_response_at  timestamptz(3),
  resolved_at        timestamptz(3),
  status             text        NOT NULL CHECK (status IN ('open', 'resolved', 'ignored')),
  classification_model text,
  version            integer     NOT NULL DEFAULT 1,        -- bloqueo optimista de las actualizaciones
  execution_id       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_tickets_open_idx ON triage_tickets (status, priority);
CREATE INDEX IF NOT EXISTS triage_tickets_assignee_idx ON triage_tickets (assignee_id) WHERE status = 'open';
-- Auditoría: cada cambio de un ticket queda con quién y cuándo.
CREATE TABLE IF NOT EXISTS triage_events (
  id         bigserial PRIMARY KEY,
  ticket_id  text        NOT NULL,
  event      text        NOT NULL,   -- triaged | ignored | first_response | resolved | reassigned
  actor      text        NOT NULL,   -- 'system' o quien lo hizo
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_events_ticket_idx ON triage_events (ticket_id);
-- Cada alerta de SLA se envía una vez: la clave se registra DESPUÉS de enviar (si el email falla, se reintenta).
CREATE TABLE IF NOT EXISTS triage_sla_alerts (
  alert_key  text PRIMARY KEY,       -- <ticket_id>|<first_response|resolution>|<warning|breached>
  ticket_id  text        NOT NULL,
  recipients jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Appointment Reminders + No-show Reducer ─────────────
-- Datos de prueba (mock del calendario/CRM). En live: GoHighLevel / Google Calendar. Las bajas usan la misma suppression_list de Revival.
CREATE TABLE IF NOT EXISTS appt_contacts (
  contact_id text PRIMARY KEY,
  name       text NOT NULL,
  email      text,
  phone      text,
  timezone   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Calendario mock: un horario, una cita. El UPDATE ... WHERE status = 'free' es lo que impide la doble reserva.
CREATE TABLE IF NOT EXISTS appt_slots (
  slot_id        text PRIMARY KEY,
  starts_at      timestamptz(3) NOT NULL UNIQUE,
  duration_min   integer NOT NULL DEFAULT 30,
  service        text,
  status         text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'booked')),
  appointment_id text
);
CREATE TABLE IF NOT EXISTS appt_appointments (
  appointment_id  text PRIMARY KEY,
  contact_id      text NOT NULL,
  service         text NOT NULL,
  starts_at       timestamptz(3) NOT NULL,
  duration_min    integer NOT NULL DEFAULT 30,
  slot_id         text,
  status          text NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'rescheduled', 'attended', 'no_show')),
  checked_in_at   timestamptz(3),
  no_show_at      timestamptz(3),
  rescheduled_to  text,                 -- reagendar crea una cita nueva y enlaza ambas: cada cita tiene sus propios recordatorios
  rescheduled_from text,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appt_appointments_status_idx ON appt_appointments (status, starts_at);
-- Un recordatorio por cita y tipo (r48 | r2 | noshow). Se registra DESPUÉS de enviarlo; 'skipped' deja el motivo a la vista.
CREATE TABLE IF NOT EXISTS appt_reminders (
  appointment_id text NOT NULL,
  kind           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('sent', 'skipped')),
  reason         text,
  recipients     text,
  execution_id   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appointment_id, kind)
);
-- Qué espera cada contacto: respuesta al recordatorio, elección de horario o respuesta a una oferta de lista de espera.
CREATE TABLE IF NOT EXISTS appt_conversation (
  contact_id     text PRIMARY KEY,
  awaiting       text CHECK (awaiting IN ('reminder', 'slot_choice', 'waitlist_offer')),
  appointment_id text,
  offered_slots  jsonb NOT NULL DEFAULT '[]'::jsonb,
  offer_slot_id  text,
  attempts       integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS appt_waitlist (
  id              bigserial PRIMARY KEY,
  contact_id      text NOT NULL,
  service         text,
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'booked', 'removed')),
  declined_slots  jsonb NOT NULL DEFAULT '[]'::jsonb,
  offered_slot_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS appt_messages (
  id             bigserial PRIMARY KEY,
  contact_id     text NOT NULL,
  direction      text NOT NULL,          -- in | out
  kind           text NOT NULL,
  body           text NOT NULL,
  status         text NOT NULL,          -- sent | failed | received
  appointment_id text,
  execution_id   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appt_messages_contact_idx ON appt_messages (contact_id, created_at);
CREATE TABLE IF NOT EXISTS appt_events (
  id             bigserial PRIMARY KEY,
  appointment_id text NOT NULL,
  event          text NOT NULL,
  actor          text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appt_events_idx ON appt_events (appointment_id);

-- ───────────── Client Onboarding ─────────────
-- Mock de las herramientas del cliente nuevo (Drive, gestor de proyectos, CRM). En live: Google Drive / Asana / GoHighLevel.
CREATE TABLE IF NOT EXISTS onb_clients (
  client_id     text PRIMARY KEY,
  company       text        NOT NULL,
  contact_name  text        NOT NULL,
  contact_email text        NOT NULL,
  package       text        NOT NULL,
  amount        numeric     NOT NULL,
  currency      text        NOT NULL,
  start_date    date        NOT NULL,
  notes         text,
  status        text        NOT NULL CHECK (status IN ('contract_pending', 'awaiting_signature', 'provisioning', 'provisioning_failed', 'active', 'rejected', 'expired', 'cancelled')),
  summary       jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- requisitos del formulario (solo los fundamentados en las notas)
  flags         jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- por qué pasó por una persona
  crm_stage     text,
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onb_clients_email_idx ON onb_clients (lower(contact_email));
CREATE INDEX IF NOT EXISTS onb_clients_company_idx ON onb_clients (lower(company));
-- El token de firma es de un solo uso (signed_at) y caduca (expires_at). Se genera en Postgres, nunca en la IA.
CREATE TABLE IF NOT EXISTS onb_contracts (
  client_id    text PRIMARY KEY,
  text         text        NOT NULL,
  token        text        NOT NULL,
  approved_by  text,
  sent_at      timestamptz,
  expires_at   timestamptz NOT NULL,
  signed_at    timestamptz,
  nudged_at    timestamptz,
  escalated_at timestamptz
);
-- Cada paso del aprovisionamiento, uno por cliente: volver a ejecutarlo no duplica nada y deja ver cuál falló.
CREATE TABLE IF NOT EXISTS onb_steps (
  client_id    text NOT NULL,
  step         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('ok', 'failed')),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  execution_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, step)
);
CREATE TABLE IF NOT EXISTS onb_assets (client_id text PRIMARY KEY, folder text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS onb_projects (project_id text PRIMARY KEY, client_id text NOT NULL UNIQUE, name text NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS onb_tasks (
  id         bigserial PRIMARY KEY,
  client_id  text NOT NULL,
  title      text NOT NULL,
  due_date   date NOT NULL,
  owner_role text NOT NULL,
  source     text NOT NULL,            -- template | intake
  status     text NOT NULL DEFAULT 'open',
  UNIQUE (client_id, title)
);
CREATE TABLE IF NOT EXISTS onb_outbox (
  id         bigserial PRIMARY KEY,
  client_id  text NOT NULL,
  kind       text NOT NULL,            -- welcome | checkin | kickoff
  send_after timestamptz(3) NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
  reason     text,
  sent_at    timestamptz,
  UNIQUE (client_id, kind)
);
CREATE INDEX IF NOT EXISTS onb_outbox_due_idx ON onb_outbox (send_after) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS onb_events (
  id         bigserial PRIMARY KEY,
  client_id  text NOT NULL,
  event      text NOT NULL,
  actor      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onb_events_client_idx ON onb_events (client_id);
