const { Workflow, embed, uid, code, ifBool, logBranch, pg } = require('../foundation');
const { SYNC } = require('./sync-config');

const WF = 'sync-review';
const col = n => n * 240;
const FIELDS = ['name', 'email', 'phone', 'company', 'stage'];
const setFields = tbl => FIELDS.map(f => `${f} = CASE WHEN jsonb_exists(x.fields, '${f}') THEN x.fields->>'${f}' ELSE ${tbl}.${f} END`).join(', ');

// Misma política que la revisión de Revival: sin scripts, sin recursos externos, sin caché, formularios solo hacia este origen.
const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Content-Security-Policy', value: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  { name: 'Cache-Control', value: 'no-store' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] };
function respondHtml(w, name, position) {
  return w.add(name, 'n8n-nodes-base.respondToWebhook', 1.4, position,
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.http_status || 200 }}', responseHeaders: HTML_HEADERS } });
}

const LOAD_SQL = `SELECT r.review_id, r.token, (r.expires_at < now()) AS expired,
  COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM (
    SELECT id, crm_id, sheet_id, field, crm_value, sheet_value, base_value, crm_updated_at, sheet_updated_at FROM sync_conflicts WHERE status = 'open') c), '[]'::jsonb) AS conflicts
FROM sync_reviews r WHERE r.review_id = $1 AND r.token = $2`;

// UNA sentencia atómica. Cada elección solo se aplica si NINGUNO de los dos registros cambió desde que se detectó el conflicto.
const PERSIST_SQL = `WITH rv AS (SELECT 1 AS ok FROM sync_reviews WHERE review_id = $1 AND token = $2 AND expires_at > now()),
w AS (
  SELECT x.* FROM jsonb_to_recordset($3::jsonb) AS x(conflict_id bigint, choice text, write_to text, field text, value text, base text, crm_id text, sheet_id text, crm_updated_at timestamptz, sheet_updated_at timestamptz)
  WHERE EXISTS (SELECT 1 FROM rv)
),
okk AS (
  SELECT w.* FROM w JOIN sync_conflicts c ON c.id = w.conflict_id AND c.status = 'open'
  WHERE EXISTS (SELECT 1 FROM sync_crm_contacts a WHERE a.id = w.crm_id AND a.updated_at = w.crm_updated_at)
    AND EXISTS (SELECT 1 FROM sync_sheet_rows b WHERE b.id = w.sheet_id AND b.updated_at = w.sheet_updated_at)
),
tc AS (SELECT crm_id AS id, jsonb_object_agg(field, value) AS fields FROM okk WHERE write_to = 'crm' GROUP BY crm_id),
ts AS (SELECT sheet_id AS id, jsonb_object_agg(field, value) AS fields FROM okk WHERE write_to = 'sheet' GROUP BY sheet_id),
uc AS (UPDATE sync_crm_contacts t SET ${setFields('t')} FROM tc x WHERE t.id = x.id RETURNING t.id),
us AS (UPDATE sync_sheet_rows t SET ${setFields('t')} FROM ts x WHERE t.id = x.id RETURNING t.id),
lk AS (
  UPDATE sync_links l SET base = l.base || a.b, updated_at = now()
  FROM (SELECT crm_id, sheet_id, jsonb_object_agg(field, base) AS b FROM okk GROUP BY crm_id, sheet_id) a
  WHERE l.crm_id = a.crm_id AND l.sheet_id = a.sheet_id RETURNING l.link_id
),
cr AS (UPDATE sync_conflicts c SET status = 'resolved', resolution = okk.choice, resolved_at = now() FROM okk WHERE c.id = okk.conflict_id RETURNING c.id),
ch AS (
  INSERT INTO sync_changes (run_id, side, action, entity_id, field, old_value, new_value, source_id)
  SELECT $4, okk.write_to, 'resolve_conflict', CASE WHEN okk.write_to = 'crm' THEN okk.crm_id ELSE okk.sheet_id END, okk.field,
         CASE WHEN okk.write_to = 'crm' THEN c.crm_value ELSE c.sheet_value END, okk.value, 'review:' || okk.choice
  FROM okk JOIN sync_conflicts c ON c.id = okk.conflict_id RETURNING id
)
SELECT (SELECT count(*) FROM rv) AS review_valid, (SELECT count(*) FROM w) AS requested, (SELECT count(*) FROM cr) AS resolved, (SELECT count(*) FROM ch) AS logged,
       (SELECT count(*) FROM uc) + (SELECT count(*) FROM us) AS records_written`;

module.exports = function syncReview() {
  const w = Workflow('syncreview000001', 'Sync · Conflict Review (Auditable)');

  // ════════ GET: mostrar los conflictos abiertos ════════
  w.add('Review Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 100],
    { httpMethod: 'GET', path: 'sync-review', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'La persona llega aquí desde el link del email (?review=…&token=…). Sin token válido y vigente no se muestra nada.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 100],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SYNC }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Query', 'n8n-nodes-base.code', 2, [col(2), 100], code(
    `const item = $input.item.json;
const q = item.query || {};
const ok = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
return { json: { review: ok(q.review) ? q.review : '', token: ok(q.token) ? q.token : '', config: item.config } };`))
   .add('Query Valid?', 'n8n-nodes-base.if', 2.2, [col(3), 100], ifBool('={{ !!$json.review && !!$json.token }}'))
   .add('Render Invalid', 'n8n-nodes-base.code', 2, [col(4), 300], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }],
    `return { json: { html: renderMessagePage({ title: 'Link not valid', message: 'This review link is missing information. Open the link from the email again.' }), http_status: 400 } };`)));

  pg(w, 'Load Conflicts', [col(4), 100], LOAD_SQL, '[$json.review, $json.token]', { alwaysOutputData: true });
  w.add('Render Conflicts', 'n8n-nodes-base.code', 2, [col(5), 100], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }, { file: 'sync', exports: [] }, { file: 'syncreview', exports: ['renderConflictsPage'] }],
    `const s = $('Parse Query').item.json;
const r = $input.item.json;
if (!r.review_id) return { json: { ...s, html: renderMessagePage({ title: 'Link not valid', message: 'This review link is not valid.' }), http_status: 403, outcome: 'invalid_token' } };
if (r.expired) return { json: { ...s, html: renderMessagePage({ title: 'Link expired', message: 'This review link expired. The next sync run sends a new one if conflicts are still open.' }), http_status: 410, outcome: 'expired' } };
const html = renderConflictsPage({ review: { review_id: r.review_id, token: s.token }, conflicts: r.conflicts, submitUrl: s.config.reviewSubmitUrl, dataLabel: s.config.dataLabel });
return { json: { ...s, html, http_status: 200, outcome: 'shown', conflicts_count: r.conflicts.length } };`)),
    { notes: 'Todo dato del CRM o la hoja se escapa en el render.' });
  respondHtml(w, 'Respond Page', [col(6), 100]);

  // ════════ POST: recibir las decisiones ════════
  w.add('Submit Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 560],
    { httpMethod: 'POST', path: 'sync-review-submit', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Recibe el formulario de la página (application/x-www-form-urlencoded).' })
   .add('Config (submit)', 'n8n-nodes-base.set', 3.4, [col(1), 560],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SYNC }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Submit', 'n8n-nodes-base.code', 2, [col(2), 560], code(
    `const item = $input.item.json;
const body = item.body || {};
const ok = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
return { json: { form: body, review: ok(body.review) ? body.review : '', token: ok(body.token) ? body.token : '', config: item.config } };`))
   .add('Submit Valid?', 'n8n-nodes-base.if', 2.2, [col(3), 560], ifBool('={{ !!$json.review && !!$json.token }}'))
   .add('Render Invalid Submit', 'n8n-nodes-base.code', 2, [col(4), 760], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }],
    `return { json: { html: renderMessagePage({ title: 'Submission not valid', message: 'The form is missing information. Nothing was changed.' }), http_status: 400 } };`)));

  pg(w, 'Load Conflicts (submit)', [col(4), 560], LOAD_SQL, '[$json.review, $json.token]', { alwaysOutputData: true });
  w.add('Build Resolution', 'n8n-nodes-base.code', 2, [col(5), 560], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }, { file: 'sync', exports: [] }, { file: 'syncreview', exports: ['buildResolution'] }],
    `const s = $('Parse Submit').item.json;
const r = $input.item.json;
const fail = (title, message, status, outcome) => ({ json: { ...s, can_apply: false, html: renderMessagePage({ title, message }), http_status: status, outcome } });
if (!r.review_id) return fail('Submission not valid', 'The link or token is not valid. Nothing was changed.', 403, 'invalid_token');
if (r.expired) return fail('Link expired', 'This review link expired. Nothing was changed.', 410, 'expired');
const { writes, summary } = buildResolution(r.conflicts, s.form);
return { json: { ...s, can_apply: true, writes, summary } };`)),
    { notes: 'DETERMINÍSTICO y fail-closed: sin elección clara = pendiente. El valor se normaliza igual que en la sincronización.' })
   .add('Can Apply?', 'n8n-nodes-base.if', 2.2, [col(6), 560], ifBool('={{ $json.can_apply }}'));
  respondHtml(w, 'Respond Page (submit)', [col(7), 760]);

  pg(w, 'Persist Resolution', [col(7), 560], PERSIST_SQL, '[$json.review, $json.token, JSON.stringify($json.writes), $execution.id]',
    { notes: 'UNA sentencia atómica. Una elección se aplica solo si ninguno de los dos registros cambió desde que se detectó el conflicto; si cambió, queda abierto.' });
  w.add('Resolution Persisted', 'n8n-nodes-base.code', 2, [col(8), 560], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }, { file: 'sync', exports: [] }, { file: 'syncreview', exports: ['renderResolvedPage'] }],
    `const s = $('Build Resolution').item.json;
const r = $input.item.json;
if (s.writes.length > 0 && Number(r.review_valid) !== 1) return { json: { ...s, applied: false, html: renderMessagePage({ title: 'Link expired', message: 'This review link expired while you were choosing. Nothing was changed.' }), http_status: 410, outcome: 'expired_race' } };
const resolved = Number(r.resolved);
if (Number(r.logged) !== resolved) throw new Error('Conflict review wrote ' + resolved + ' resolutions but logged ' + r.logged + ' changes');
const stale = s.writes.length - resolved;
return { json: { ...s, applied: true, resolved, stale, html: renderResolvedPage({ resolved, stale, pending: s.summary.pending, dataLabel: s.config.dataLabel }), http_status: 200, outcome: 'submitted' } };`)));
  respondHtml(w, 'Respond Result', [col(9), 560]);

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.review', ...o });
  L('Render Conflicts', { step: 'review_page_shown', status: "$json.outcome === 'shown' ? 'ok' : 'skipped'", error: "$json.outcome === 'shown' ? '' : $json.outcome", detail: '({ conflicts: $json.conflicts_count ?? 0 })' });
  L('Build Resolution', { step: 'review_evaluated', status: "$json.can_apply ? 'ok' : 'skipped'", error: "$json.can_apply ? '' : $json.outcome", detail: '({ summary: $json.summary ?? null })' });
  L('Resolution Persisted', { step: 'review_submitted', status: "$json.applied ? 'ok' : 'skipped'", error: "$json.applied ? '' : $json.outcome", detail: '({ resolved: $json.resolved ?? 0, stale: $json.stale ?? 0 })' });

  w.note('## Sync · Conflict Review\nA person opens the link from the email and, for each field both systems changed, picks the CRM value, the Sheet value or "decide later". The chosen value is copied to the other system and the last-synced value is updated, atomically. Anything unclear stays open.', [col(0) - 20, -250], col(9), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 960], 400, 90);

  w.link('Review Webhook', 'Config').link('Config', 'Parse Query').link('Parse Query', 'Query Valid?')
   .link('Query Valid?', 'Load Conflicts', 0).link('Query Valid?', 'Render Invalid', 1)
   .link('Load Conflicts', 'Render Conflicts').link('Render Conflicts', 'Respond Page').link('Render Invalid', 'Respond Page')
   .link('Submit Webhook', 'Config (submit)').link('Config (submit)', 'Parse Submit').link('Parse Submit', 'Submit Valid?')
   .link('Submit Valid?', 'Load Conflicts (submit)', 0).link('Submit Valid?', 'Render Invalid Submit', 1)
   .link('Render Invalid Submit', 'Respond Page (submit)')
   .link('Load Conflicts (submit)', 'Build Resolution').link('Build Resolution', 'Can Apply?')
   .link('Can Apply?', 'Persist Resolution', 0).link('Can Apply?', 'Respond Page (submit)', 1)
   .link('Persist Resolution', 'Resolution Persisted').link('Resolution Persisted', 'Respond Result');

  return { file: 'sync-review.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
