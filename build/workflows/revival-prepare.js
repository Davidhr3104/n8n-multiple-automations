const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-prepare';
const col = n => n * 240;

module.exports = function revivalPrepare() {
  const w = Workflow('revivalprepare01', 'Revival · Prepare Draft (Auditable)');

  // ── Entrada + validación ──
  w.add('Prepare Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'revival-prepare', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Lo llama Revival · Daily Run, un POST por contacto y de forma SÍNCRONA: responde cuando el borrador ya está guardado. NO envía nada.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-revival-token'] !== c.internalToken) errors.push('bad_token');
if (typeof b.batch_id !== 'string' || !b.batch_id) errors.push('batch_id');
if (typeof b.contact_id !== 'string' || !b.contact_id) errors.push('contact_id');
if (!Number.isInteger(b.touch)) errors.push('touch');
if (!['new', 'follow_up'].includes(b.kind)) errors.push('kind');
return { json: { request: { batch_id: b.batch_id, contact_id: b.contact_id, touch: b.touch, kind: b.kind }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 700], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Guarda: solo se preparan borradores de un lote "preparing", sin baja y con el toque en orden ──
  pg(w, 'Load Guard', [col(4), 200],
    `SELECT c.contact_id, c.name, c.email, c.phone, c.company, c.history, c.timezone,
       b.status AS batch_status,
       COALESCE(s.step, 0) AS step, COALESCE(s.status, 'new') AS state_status,
       EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(c.email) OR x.key = norm_phone(c.phone, '57')) AS suppressed
FROM revival_contacts c
JOIN revival_batches b ON b.batch_id = $2
LEFT JOIN revival_state s ON s.contact_id = c.contact_id
WHERE c.contact_id = $1`,
    '[$json.request.contact_id, $json.request.batch_id]', { alwaysOutputData: true });
  w.add('Guard Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(
    [{ file: 'revival', exports: ['canPrepare'] }],
    `const s = $('Validate Request').item.json;
const row = $input.item.json.contact_id ? $input.item.json : null;
const guard = canPrepare(row, s.request.touch, s.config);
const contact = row ? { contact_id: row.contact_id, name: row.name, email: row.email, phone: row.phone, company: row.company, history: row.history, timezone: row.timezone } : null;
return { json: { ...s, contact, guard: { ...guard, row: row ? { batch_status: row.batch_status, state_status: row.state_status, step: row.step, suppressed: row.suppressed } : null } } };`)),
    { notes: 'DETERMINÍSTICO: no confía en quien llama.' })
   .add('Can Prepare?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.guard.ok }}'));
  respond(w, 'Respond 409 (blocked)', [col(7), 480], 409, '{ status: "blocked", reason: $json.guard.reason, contact_id: $json.request.contact_id, touch: $json.request.touch }');

  idempotency(w, {
    workflow: WF, position: [col(7), 100], paramCount: 3, params: '$json.request.batch_id, $json.request.contact_id, String($json.request.touch)',
    stateFrom: 'Guard Result', check: 'New draft?',
    keySql: "'revival-draft:' || $1 || ':' || $2 || ':' || $3",
  });
  respond(w, 'Duplicate 200', [col(10), 300], 200, '{ status: "duplicate", contact_id: $json.request.contact_id, touch: $json.request.touch }');

  // ── Mensaje personalizado (IA o mock) ──
  w.add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(10), 100], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Touch Request', 'n8n-nodes-base.code', 2, [col(11), 0], code(embed(
    [{ file: 'revival', exports: ['buildTouchRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildTouchRequest(s.contact, s.request.touch, s.config, s.config.model) } };`)))
   .add('Mock Touch', 'n8n-nodes-base.code', 2, [col(11), 240], code(embed(
    [{ file: 'revival', exports: ['mockTouch'] }],
    `const s = $input.item.json;
return { json: { ...s, ai: { ok: true, message: mockTouch(s.contact, s.request.touch), model: 'mock' } } };`)),
    { notes: 'Sustituto local de Claude (aiMode=mock): determinístico, usa la última nota del historial.' });

  const claudeExit = httpWithBackoff(w, {
    name: 'Claude Touch', position: [col(12), 0], source: 'Build Touch Request', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API" (Header Auth: x-api-key).',
    params: {
      method: 'POST',
      url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.claude_request) }}',
      options: { timeout: 60000 },
    },
  });
  w.add('Parse Touch', 'n8n-nodes-base.code', 2, [col(15), 0], code(embed(
    [{ file: 'revival', exports: ['parseTouchResponse'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, ai: parseTouchResponse(http_response) } };`)))
   .add('Compose Message', 'n8n-nodes-base.code', 2, [col(16), 100], code(embed(
    [{ file: 'revival', exports: ['finalizeMessage'] }],
    `const s = $input.item.json;
let outbound;
if (!s.ai.ok) outbound = { ok: false, issues: ['ai_failed'], core: '', text: '', error: s.ai.error };
else {
  const core = s.ai.message + '\\n— ' + s.config.senderName;
  const f = finalizeMessage(core);
  outbound = { ok: f.ok, issues: f.issues, core, text: f.text };
}
return { json: { ...s, outbound } };`)),
    { notes: 'DETERMINÍSTICO: el pie de baja lo agrega este código (no la IA) y se rechaza todo mensaje con URLs, promesas de precio/garantía o demasiado largo. "core" es lo que el dueño puede editar; "text" lleva el pie.' })
   .add('Message OK?', 'n8n-nodes-base.if', 2.2, [col(17), 100], ifBool('={{ $json.outbound.ok }}'));

  // ── Borrador listo para revisar ──
  w.add('Infer Timezone', 'n8n-nodes-base.code', 2, [col(18), 0], code(embed(
    [{ file: 'schedule', exports: ['inferTimezone'] }],
    `const s = $input.item.json;
return { json: { ...s, tzinfo: inferTimezone({ timezone: s.contact.timezone, phone: s.contact.phone }, s.config) } };`)),
    { notes: 'Zona del contacto > prefijo del teléfono > zona por defecto. La fuente queda guardada: una zona supuesta se declara.' });
  pg(w, 'Save Draft', [col(19), 0],
    `INSERT INTO revival_drafts (batch_id, contact_id, touch, kind, status, body_core, body, original_body, tz, tz_source, execution_id)
VALUES ($1, $2, $3::int, $4, 'pending_review', $5, $6, $5, $7, $8, $9)
ON CONFLICT (batch_id, contact_id, touch) DO UPDATE SET status = 'pending_review', body_core = EXCLUDED.body_core, body = EXCLUDED.body,
  original_body = EXCLUDED.original_body, tz = EXCLUDED.tz, tz_source = EXCLUDED.tz_source, execution_id = EXCLUDED.execution_id, reason = NULL
RETURNING id`,
    '[$json.request.batch_id, $json.request.contact_id, String($json.request.touch), $json.request.kind, $json.outbound.core, $json.outbound.text, $json.tzinfo.tz, $json.tzinfo.source, $execution.id]');
  w.add('Draft Saved', 'n8n-nodes-base.code', 2, [col(20), 0], code(
    `const s = $('Infer Timezone').item.json;
return { json: { ...s, draft_id: Number($input.item.json.id), draft_status: 'pending_review' } };`));
  respond(w, 'Respond Ready', [col(21), 0], 200, '{ status: "pending_review", draft_id: $json.draft_id, contact_id: $json.request.contact_id, touch: $json.request.touch }');

  // ── Borrador bloqueado (política) o fallido (IA): NO se enviará; el dueño ve el motivo ──
  pg(w, 'Save Blocked Draft', [col(18), 420],
    `WITH d AS (
  INSERT INTO revival_drafts (batch_id, contact_id, touch, kind, status, body_core, body, original_body, reason, execution_id)
  VALUES ($1, $2, $3::int, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($6, ''), $8, $9)
  ON CONFLICT (batch_id, contact_id, touch) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, body_core = EXCLUDED.body_core,
    body = EXCLUDED.body, original_body = EXCLUDED.original_body, execution_id = EXCLUDED.execution_id
  RETURNING id
), st AS (
  INSERT INTO revival_state (contact_id, status, step, batch_id)
  SELECT $2, 'needs_review', COALESCE((SELECT step FROM revival_state WHERE contact_id = $2), 0), $1 WHERE $10::boolean
  ON CONFLICT (contact_id) DO UPDATE SET status = 'needs_review', updated_at = now() RETURNING contact_id
)
SELECT (SELECT id FROM d) AS id, (SELECT count(*) FROM st) AS states`,
    "[$json.request.batch_id, $json.request.contact_id, String($json.request.touch), $json.request.kind, $json.outbound.issues.includes('ai_failed') ? 'failed' : 'blocked', $json.outbound.core || '', $json.outbound.text || '', $json.outbound.issues.join(',') + ($json.outbound.error ? ': ' + String($json.outbound.error).slice(0, 200) : ''), $execution.id, String(!$json.outbound.issues.includes('ai_failed'))]",
    { notes: 'Un bloqueo por POLÍTICA deja al contacto en needs_review (no se reintenta solo). Un fallo de IA no cambia su estado: se reintenta en la próxima corrida.' });
  w.add('Blocked Saved', 'n8n-nodes-base.code', 2, [col(19), 420], code(
    `const s = $('Message OK?').item.json;
return { json: { ...s, draft_id: Number($input.item.json.id), draft_status: s.outbound.issues.includes('ai_failed') ? 'failed' : 'blocked' } };`));
  respond(w, 'Respond Blocked', [col(20), 420], 200, '{ status: $json.draft_status, contact_id: $json.request.contact_id, touch: $json.request.touch, reason: $json.outbound.issues.join(",") }');

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(22), 200], code(
    `const s = $input.item.json;
const status = s.draft_status === 'pending_review' ? 'ready' : (s.draft_status === 'failed' ? 'ai_failed' : 'blocked');
return { json: { ...s, result: { status, contact_id: s.request.contact_id, touch: s.request.touch, draft_id: s.draft_id } } };`));
  markIdempotency(w, {
    position: [col(23), 40], keyExpr: '$json.idem.key',
    statusExpr: "$json.result.status === 'ai_failed' ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status, draft_id: $json.result.draft_id })',
  });
  w.add('Assert Draft', 'n8n-nodes-base.code', 2, [col(23), 200], code(
    `const s = $input.item.json;
const r = s.result;
if (r.status === 'ai_failed') throw new Error('Draft for ' + r.contact_id + ' (touch ' + r.touch + '): the AI failed (' + s.outbound.error + '). No draft to review; it will be retried on the next run.');
if (r.status === 'blocked') throw new Error('Draft for ' + r.contact_id + ' (touch ' + r.touch + ') was BLOCKED by message policy (' + s.outbound.issues.join(',') + '); contact set to needs_review. It will not be sent.');
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de guardar el borrador y de responder → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.request.contact_id', ...o });
  L('Validate Request', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ touch: $json.request.touch, batch: $json.request.batch_id })' });
  L('Guard Result', { step: 'guard_checked', status: "$json.guard.ok ? 'ok' : 'skipped'", error: "$json.guard.ok ? '' : $json.guard.reason", detail: '({ guard: $json.guard.row })' });
  L('Idempotency Result', { step: 'draft_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Mock Touch', { step: 'message_generated', name: 'Log · message_generated (mock)', detail: '({ model: "mock" })' });
  L('Parse Touch', { step: 'message_generated', name: 'Log · message_generated (live)', status: "$json.ai.ok ? 'ok' : 'failed'", error: "$json.ai.error ?? ''", detail: '({ attempts: $json.http.attempt })' });
  L('Compose Message', { step: 'message_checked', status: "$json.outbound.ok ? 'ok' : 'failed'", error: "$json.outbound.ok ? '' : $json.outbound.issues.join(',')" });
  L('Draft Saved', { step: 'draft_saved', detail: '({ draft_id: $json.draft_id, tz: $json.tzinfo.tz, tz_source: $json.tzinfo.source })' });
  L('Build Result', { step: 'completed', status: "$json.result.status === 'ready' ? 'ok' : ($json.result.status === 'blocked' ? 'skipped' : 'failed')", error: "$json.result.status === 'ready' ? '' : $json.result.status", detail: '({ result: $json.result })' });

  w.note('## Revival · Prepare Draft (one per contact)\nGuard (batch preparing, no opt-out, touch in order) → idempotency → personalized message → validation + opt-out footer → draft saved for the owner to review. Nothing is sent here.', [col(0) - 20, -330], col(12), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches.', [col(0) - 20, 760], 480, 90);

  // ── Conexiones ──
  w.link('Prepare Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load Guard', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load Guard', 'Guard Result').link('Guard Result', 'Can Prepare?')
   .link('Can Prepare?', 'Claim Idempotency', 0).link('Can Prepare?', 'Respond 409 (blocked)', 1)
   .link('New draft?', 'AI Mode?', 0).link('New draft?', 'Duplicate 200', 1)
   .link('AI Mode?', 'Build Touch Request', 0).link('AI Mode?', 'Mock Touch', 1)
   .link('Build Touch Request', 'Claude Touch').link(claudeExit, 'Parse Touch', 1)
   .link('Parse Touch', 'Compose Message').link('Mock Touch', 'Compose Message')
   .link('Compose Message', 'Message OK?')
   .link('Message OK?', 'Infer Timezone', 0).link('Message OK?', 'Save Blocked Draft', 1)
   .link('Infer Timezone', 'Save Draft').link('Save Draft', 'Draft Saved').link('Draft Saved', 'Respond Ready').link('Respond Ready', 'Build Result')
   .link('Save Blocked Draft', 'Blocked Saved').link('Blocked Saved', 'Respond Blocked').link('Respond Blocked', 'Build Result')
   .link('Build Result', 'Mark Idempotency').link('Build Result', 'Assert Draft');

  return { file: 'revival-prepare.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
