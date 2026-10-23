const { Workflow, embed, uid, code, pg } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const col = n => n * 240;

const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Content-Security-Policy', value: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" },
  { name: 'Cache-Control', value: 'no-store' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] };

// $1 = '7' | '30' | 'all'. Todo son conteos; los porcentajes se calculan al dibujar.
const METRICS_SQL = `WITH p AS (
  SELECT CASE WHEN $1::text ~ '^[0-9]+$' THEN now() - make_interval(days => $1::text::int) END AS since,
         CASE WHEN $1::text ~ '^[0-9]+$' THEN $1::text::int END AS days
), dr AS (
  SELECT d.* FROM revival_drafts d, p WHERE p.since IS NULL OR d.created_at >= p.since
), msg AS (
  SELECT m.* FROM revival_messages m, p WHERE p.since IS NULL OR m.created_at >= p.since
)
SELECT
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' AS generated_at,
  (SELECT days FROM p) AS days,
  jsonb_build_object(
    'total', (SELECT count(*) FROM dr),
    'sent', (SELECT count(*) FROM dr WHERE status = 'sent'),
    'approved', (SELECT count(*) FROM dr WHERE status = 'approved'),
    'deferred', (SELECT count(*) FROM dr WHERE status = 'deferred'),
    'pending_review', (SELECT count(*) FROM dr WHERE status = 'pending_review'),
    'skipped', (SELECT count(*) FROM dr WHERE status = 'skipped'),
    'blocked', (SELECT count(*) FROM dr WHERE status = 'blocked'),
    'failed', (SELECT count(*) FROM dr WHERE status = 'failed'),
    'edited', (SELECT count(*) FROM dr WHERE edited AND status IN ('approved','deferred','sent'))
  ) AS drafts,
  jsonb_build_object(
    'messaged', (SELECT count(DISTINCT contact_id) FROM msg WHERE direction = 'out' AND status IN ('sent','booking_sent')),
    'active', (SELECT count(*) FROM revival_state WHERE status = 'active'),
    'completed', (SELECT count(*) FROM revival_state WHERE status = 'completed'),
    'booking_sent', (SELECT count(*) FROM revival_state WHERE status = 'booking_sent'),
    'not_interested', (SELECT count(*) FROM revival_state WHERE status = 'not_interested'),
    'opted_out', (SELECT count(*) FROM revival_state WHERE status = 'opted_out'),
    'needs_review', (SELECT count(*) FROM revival_state WHERE status = 'needs_review')
  ) AS contacts,
  jsonb_build_object(
    'total', (SELECT count(*) FROM msg WHERE direction = 'in'),
    'contacts_replied', (SELECT count(DISTINCT contact_id) FROM msg WHERE direction = 'in'),
    'by_label', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', classification, 'n', n) ORDER BY n DESC)
        FROM (SELECT classification, count(*) AS n FROM msg WHERE direction = 'in' AND classification IS NOT NULL GROUP BY 1) x), '[]'::jsonb)
  ) AS replies,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('touch', touch, 'sent', n) ORDER BY touch)
      FROM (SELECT touch, count(*) AS n FROM dr WHERE status = 'sent' GROUP BY 1) x), '[]'::jsonb) AS touches,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('batch_id', batch_id, 'status', status, 'size', size, 'sent', sent, 'skipped', skipped,
        'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC') ORDER BY created_at DESC)
      FROM (SELECT b.batch_id, b.status, b.size, b.created_at,
              (SELECT count(*) FROM revival_drafts d WHERE d.batch_id = b.batch_id AND d.status = 'sent') AS sent,
              (SELECT count(*) FROM revival_drafts d WHERE d.batch_id = b.batch_id AND d.status = 'skipped') AS skipped
            FROM revival_batches b, p WHERE p.since IS NULL OR b.created_at >= p.since ORDER BY b.created_at DESC LIMIT 8) x), '[]'::jsonb) AS batches,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('step', step, 'n', n) ORDER BY n DESC)
      FROM (SELECT l.step, count(*) AS n FROM execution_log l, p WHERE l.status = 'failed' AND l.workflow LIKE 'revival%'
              AND (p.since IS NULL OR l.created_at >= p.since) GROUP BY 1 LIMIT 10) x), '[]'::jsonb) AS failures`;

module.exports = function revivalDashboard() {
  const w = Workflow('revivaldash00001', 'Revival · Dashboard (Auditable)');

  w.add('Dashboard Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 100],
    { httpMethod: 'GET', path: 'revival-dashboard', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'GET /webhook/revival-dashboard?days=7|30|all. Solo lectura sobre Postgres. Sin scripts ni recursos externos.' })
   .add('Parse Query', 'n8n-nodes-base.code', 2, [col(1), 100], code(
    `const q = $input.item.json.query || {};
const days = ['7', '30', 'all'].includes(q.days) ? q.days : '7';
return { json: { days, config: ${JSON.stringify(REVIVAL)} } };`),
    { notes: 'Solo acepta 7, 30 o all; cualquier otro valor cae a 7. El valor entra a SQL como parámetro, nunca concatenado.' });

  pg(w, 'Load Metrics', [col(2), 100], METRICS_SQL, '[$json.days]', { notes: 'Una sola consulta de solo lectura: todas las cifras salen de las mismas tablas que el log de auditoría.' });
  w.add('Render Dashboard', 'n8n-nodes-base.code', 2, [col(3), 100], code(embed(
    [{ file: 'review', exports: ['esc', 'BASE_CSS'] }, { file: 'dashboard', exports: ['renderDashboard'] }],
    `const cfg = $('Parse Query').item.json.config;
const m = $input.item.json;
return { json: { html: renderDashboard(m, { dataLabel: cfg.dataLabel }) } };`)),
    { notes: 'El HTML se arma en un módulo puro con pruebas. Todo texto se escapa; las cifras con denominador 0 se muestran como "—", no como 0%.' })
   .add('Respond Dashboard', 'n8n-nodes-base.respondToWebhook', 1.4, [col(4), 100],
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: 200, responseHeaders: HTML_HEADERS } });

  w.note('## Revival · Dashboard\nRead-only page over Postgres: drafts, review outcomes, replies, opt-outs, failures. Labeled TEST DATA while the data is synthetic.', [col(0) - 20, -250], col(4), 110);

  w.link('Dashboard Webhook', 'Parse Query').link('Parse Query', 'Load Metrics').link('Load Metrics', 'Render Dashboard').link('Render Dashboard', 'Respond Dashboard');

  return { file: 'revival-dashboard.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
