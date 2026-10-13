const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-touch';
const col = n => n * 240;

module.exports = function revivalTouch() {
  const w = Workflow('revivaltouch0001', 'Revival · Send Touch (Auditable)');

  // ── Entrada + validación ──
  w.add('Touch Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'revival-touch', responseMode: 'responseNode', options: {} }, { webhookId: uid(), notes: 'Lo llama Revival · Daily Run (un POST por lead). Protegido por x-revival-token + guarda de lote aprobado.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-revival-token'] !== c.internalToken) errors.push('bad_token');
if (typeof b.contact_id !== 'string' || !b.contact_id) errors.push('contact_id');
if (typeof b.batch_id !== 'string' || !b.batch_id) errors.push('batch_id');
if (!Number.isInteger(b.touch)) errors.push('touch');
return { json: { request: { contact_id: b.contact_id, batch_id: b.batch_id, touch: b.touch }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 640], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Guarda de envío: se evalúa AQUÍ, en el momento del envío ──
  pg(w, 'Load Guard', [col(4), 200],
    `SELECT c.contact_id, c.name, c.email, c.phone, c.company, c.history,
       b.status AS batch_status,
       COALESCE(s.step, 0) AS step, COALESCE(s.status, 'new') AS state_status,
       EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(c.email) OR x.key = norm_phone(c.phone, '57')) AS suppressed
FROM revival_contacts c
JOIN revival_batches b ON b.batch_id = $2
LEFT JOIN revival_state s ON s.contact_id = c.contact_id
WHERE c.contact_id = $1`,
    '[$json.request.contact_id, $json.request.batch_id]',
    { alwaysOutputData: true, notes: 'Trae contacto + lote + estado + lista de bajas en una sola consulta.' });
  w.add('Guard Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(
    [{ file: 'revival', exports: ['canSend'] }],
    `const s = $('Validate Request').item.json;
const row = $input.item.json.contact_id ? $input.item.json : null;
const guard = canSend(row, s.request.touch, s.config);
const contact = row ? { contact_id: row.contact_id, name: row.name, email: row.email, phone: row.phone, company: row.company, history: row.history } : null;
return { json: { ...s, contact, guard: { ...guard, row: row ? { batch_status: row.batch_status, state_status: row.state_status, step: row.step, suppressed: row.suppressed } : null } } };`)),
    { notes: 'DETERMINÍSTICO: lote aprobado, sin baja, estado válido y toque en orden. No confía en lo que dijo quien llamó.' })
   .add('Can Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.guard.ok }}'));
  respond(w, 'Respond 409 (blocked)', [col(7), 460], 409, '{ status: "blocked", reason: $json.guard.reason, contact_id: $json.request.contact_id, touch: $json.request.touch }');
  pg(w, 'Side · Record Block', [col(8), 460],
    "INSERT INTO revival_messages (contact_id, touch, channel, body, status, batch_id, execution_id) VALUES ($1, $2::int, 'n/a', $3, 'blocked', $4, $5)",
    "[$json.request.contact_id, String($json.request.touch), 'blocked by guard: ' + $json.guard.reason, $json.request.batch_id, $execution.id]");

  idempotency(w, {
    workflow: WF, position: [col(7), 100], paramCount: 2, params: '$json.request.contact_id, String($json.request.touch)', stateFrom: 'Guard Result', check: 'New touch?',
    keySql: "'revival-touch:' || $1 || ':' || $2",
  });
  respond(w, 'Accepted 202', [col(10), 0], 202, '{ status: "accepted", contact_id: $json.request.contact_id, touch: $json.request.touch }');
  respond(w, 'Duplicate 200', [col(10), 280], 200, '{ status: "duplicate", contact_id: $json.request.contact_id, touch: $json.request.touch }');

  // ── Mensaje personalizado (IA o mock) ──
  w.add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(11), 0], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Touch Request', 'n8n-nodes-base.code', 2, [col(12), -100], code(embed(
    [{ file: 'revival', exports: ['buildTouchRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildTouchRequest(s.contact, s.request.touch, s.config, s.config.model) } };`)))
   .add('Mock Touch', 'n8n-nodes-base.code', 2, [col(12), 140], code(embed(
    [{ file: 'revival', exports: ['mockTouch'] }],
    `const s = $input.item.json;
return { json: { ...s, ai: { ok: true, message: mockTouch(s.contact, s.request.touch), model: 'mock' } } };`)),
    { notes: 'Sustituto local de Claude (aiMode=mock): determinístico, usa la última nota del historial.' });

  const claudeExit = httpWithBackoff(w, {
    name: 'Claude Touch', position: [col(13), -100], source: 'Build Touch Request', workflow: WF, entity: '$json.request.contact_id',
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
  w.add('Parse Touch', 'n8n-nodes-base.code', 2, [col(16), -100], code(embed(
    [{ file: 'revival', exports: ['parseTouchResponse'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, ai: parseTouchResponse(http_response) } };`)))
   .add('Compose Message', 'n8n-nodes-base.code', 2, [col(17), 0], code(embed(
    [{ file: 'revival', exports: ['finalizeMessage'] }],
    `const s = $input.item.json;
let outbound;
if (!s.ai.ok) outbound = { ok: false, issues: ['ai_failed'], text: '', error: s.ai.error };
else {
  const f = finalizeMessage(s.ai.message + '\\n— ' + s.config.senderName);
  outbound = { ok: f.ok, issues: f.issues, text: f.text, ai_text: s.ai.message };
}
return { json: { ...s, outbound } };`)),
    { notes: 'DETERMINÍSTICO: el pie de baja lo agrega este código (no la IA) y se rechaza todo mensaje con URLs, promesas de precio/garantía o demasiado largo.' })
   .add('Message OK?', 'n8n-nodes-base.if', 2.2, [col(18), 0], ifBool('={{ $json.outbound.ok }}'));

  // ── Mensaje rechazado por política o IA caída: NO se envía ──
  pg(w, 'Block Message', [col(19), 400],
    `WITH msg AS (
  INSERT INTO revival_messages (contact_id, touch, channel, body, status, batch_id, execution_id)
  VALUES ($1, $2::int, 'email', $3, 'blocked', $4, $5) RETURNING id
), st AS (
  INSERT INTO revival_state (contact_id, status, step, batch_id)
  SELECT $1, 'needs_review', COALESCE((SELECT step FROM revival_state WHERE contact_id = $1), 0), $4 WHERE $6::boolean
  ON CONFLICT (contact_id) DO UPDATE SET status = 'needs_review', updated_at = now() RETURNING contact_id
)
SELECT (SELECT count(*) FROM msg) AS msgs, (SELECT count(*) FROM st) AS states`,
    "[$json.request.contact_id, String($json.request.touch), '[BLOCKED: ' + $json.outbound.issues.join(',') + '] ' + ($json.outbound.ai_text || $json.outbound.error || ''), $json.request.batch_id, $execution.id, String(!$json.outbound.issues.includes('ai_failed'))]",
    { notes: 'Un bloqueo por POLÍTICA deja al contacto en needs_review (no se reintenta solo). Un fallo de IA NO cambia el estado: mañana se reintenta.' });
  w.add('Blocked Result', 'n8n-nodes-base.code', 2, [col(20), 400], code(`return { json: { ...$('Message OK?').item.json } };`));

  // ── Envío: mock (email local) o live (GHL) ──
  w.add('Send Mode?', 'n8n-nodes-base.if', 2.2, [col(19), 0], ifEquals('={{ $json.config.crmMode }}', 'live'))
   .add('Send Touch (mock email)', 'n8n-nodes-base.emailSend', 2.1, [col(20), 200], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.contact.email }}',
    subject: 'Following up',
    emailFormat: 'text',
    text: '={{ $json.outbound.text }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA simulada: el email llega a Mailpit. Solo se llega aquí con lote aprobado + guarda OK + mensaje validado.' })
   .add('Capture Mock Send', 'n8n-nodes-base.code', 2, [col(21), 200], code(
    `const s = $('Send Mode?').item.json;
const r = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'mock', error: JSON.stringify(r.error) } : { ok: true, mode: 'mock' } } };`));

  const sendExit = httpWithBackoff(w, {
    name: 'GHL Send Message', position: [col(20), -60], source: 'Send Mode?', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint/cuerpo de conversations/messages SIN verificar contra la API real. Envía SMS (requiere teléfono del contacto).',
    params: {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/conversations/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-04-15' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ type: 'SMS', contactId: $json.contact.contact_id, message: $json.outbound.text }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Live Send', 'n8n-nodes-base.code', 2, [col(23), -60], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'live', error: JSON.stringify(r.error) } : { ok: true, mode: 'live', response: r } } };`))
   .add('Sent OK?', 'n8n-nodes-base.if', 2.2, [col(24), 100], ifBool('={{ $json.send.ok }}'));

  // ── Persistencia: estado + mensaje + custom fields (una sola sentencia atómica) ──
  w.add('Prepare Persist', 'n8n-nodes-base.code', 2, [col(25), 0], code(embed(
    [{ file: 'revival', exports: ['nextTouchAt'] }],
    `const s = $input.item.json;
const now = new Date().toISOString();
const touch = s.request.touch;
const next = nextTouchAt(touch, s.config, now);
const done = touch >= s.config.maxTouches;
return { json: { ...s, persist: {
  status: done ? 'completed' : 'active',
  step: touch,
  next_touch_at: next || '',
  custom_fields: { revival_stage: done ? 'sequence_completed' : 'touch_' + touch + '_sent', revival_touch_count: String(touch), revival_last_touch_at: now },
} } };`)))
   .add('Persist Touch', 'n8n-nodes-base.postgres', 2.6, [col(26), 0], {
    operation: 'executeQuery',
    query: `WITH st AS (
  INSERT INTO revival_state (contact_id, status, step, next_touch_at, batch_id, updated_at)
  VALUES ($1, $2, $3::int, NULLIF($4, '')::timestamptz, $5, now())
  ON CONFLICT (contact_id) DO UPDATE SET status = EXCLUDED.status, step = EXCLUDED.step, next_touch_at = EXCLUDED.next_touch_at, batch_id = EXCLUDED.batch_id, updated_at = now()
  RETURNING contact_id
), msg AS (
  INSERT INTO revival_messages (contact_id, touch, channel, body, status, batch_id, execution_id)
  VALUES ($1, $3::int, 'email', $6, 'sent', $5, $7) RETURNING id
), cf AS (
  INSERT INTO revival_custom_fields (contact_id, field, value)
  SELECT $1, f.key, f.value FROM jsonb_each_text($8::jsonb) f(key, value)
  ON CONFLICT (contact_id, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING field
)
SELECT (SELECT count(*) FROM st) AS state_rows, (SELECT count(*) FROM msg) AS message_rows, (SELECT count(*) FROM cf) AS field_rows`,
    options: { queryReplacement: "={{ [$json.request.contact_id, $json.persist.status, String($json.persist.step), $json.persist.next_touch_at, $json.request.batch_id, $json.outbound.text, $execution.id, JSON.stringify($json.persist.custom_fields)] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, notes: 'Estado, mensaje y mirror de custom fields en UNA sentencia: o se guarda todo o nada.' })
   .add('Persisted', 'n8n-nodes-base.code', 2, [col(27), 0], code(
    `const s = $('Prepare Persist').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1 || Number(r.message_rows) !== 1) throw new Error('Persist touch wrote unexpected rows for ' + s.request.contact_id + ': ' + JSON.stringify(r));
return { json: { ...s, persisted: { ok: true, rows: r } } };`))
   .add('CF Mode?', 'n8n-nodes-base.if', 2.2, [col(28), 0], ifEquals('={{ $json.config.crmMode }}', 'live'));

  const cfExit = httpWithBackoff(w, {
    name: 'GHL Custom Fields', position: [col(29), -120], source: 'CF Mode?', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: misma credencial GoHighLevel. Forma de customFields SIN verificar contra la API real.',
    params: {
      method: 'PUT',
      url: "={{ 'https://services.leadconnectorhq.com/contacts/' + $json.contact.contact_id }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ customFields: Object.entries($json.persist.custom_fields).map(([key, v]) => ({ key: key, field_value: v })) }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Custom Fields', 'n8n-nodes-base.code', 2, [col(32), -120], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, cf: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(33), 200], code(
    `const s = $input.item.json;
let status = 'sent';
if (s.outbound && !s.outbound.ok) status = s.outbound.issues.includes('ai_failed') ? 'ai_failed' : 'blocked';
else if (s.send && !s.send.ok) status = 'send_failed';
else if (s.cf && !s.cf.ok) status = 'custom_fields_failed';
return { json: { ...s, result: { status, touch: s.request.touch, contact_id: s.request.contact_id } } };`),
    { notes: 'Todas las rutas terminan aquí: enviado, bloqueado, IA caída o envío fallido.' });
  markIdempotency(w, {
    position: [col(34), 40], keyExpr: '$json.idem.key',
    statusExpr: "['ai_failed', 'send_failed', 'custom_fields_failed'].includes($json.result.status) ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status })',
  });
  w.add('Assert Touch', 'n8n-nodes-base.code', 2, [col(34), 200], code(
    `const s = $input.item.json;
const r = s.result;
if (r.status === 'blocked') throw new Error('Touch ' + r.touch + ' to ' + r.contact_id + ' was BLOCKED by message policy (' + s.outbound.issues.join(',') + '); contact set to needs_review. Nothing was sent.');
if (r.status === 'ai_failed') throw new Error('Touch ' + r.touch + ' to ' + r.contact_id + ': the AI failed (' + s.outbound.error + '). Nothing was sent; it will be retried on the next run.');
if (r.status === 'send_failed') throw new Error('Touch ' + r.touch + ' to ' + r.contact_id + ': sending failed: ' + s.send.error + '. State unchanged; it will be retried on the next run.');
if (r.status === 'custom_fields_failed') throw new Error('Touch ' + r.touch + ' sent to ' + r.contact_id + ' but updating custom fields failed: ' + s.cf.error);
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.request.contact_id', ...o });
  L('Validate Request', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ touch: $json.request.touch, batch: $json.request.batch_id })' });
  L('Guard Result', { step: 'guard_checked', status: "$json.guard.ok ? 'ok' : 'skipped'", error: "$json.guard.ok ? '' : $json.guard.reason", detail: '({ touch: $json.request.touch, guard: $json.guard.row })' });
  L('Idempotency Result', { step: 'touch_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'", detail: '({ touch: $json.request.touch })' });
  L('Mock Touch', { step: 'message_generated', name: 'Log · message_generated (mock)', detail: '({ model: "mock" })' });
  L('Parse Touch', { step: 'message_generated', name: 'Log · message_generated (live)', status: "$json.ai.ok ? 'ok' : 'failed'", error: "$json.ai.error ?? ''", detail: '({ attempts: $json.http.attempt })' });
  L('Compose Message', { step: 'message_checked', status: "$json.outbound.ok ? 'ok' : 'failed'", error: "$json.outbound.ok ? '' : $json.outbound.issues.join(',')", detail: '({ issues: $json.outbound.issues })' });
  L('Capture Mock Send', { step: 'touch_sent', name: 'Log · touch_sent (mock)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ touch: $json.request.touch, mode: "mock" })' });
  L('Capture Live Send', { step: 'touch_sent', name: 'Log · touch_sent (live)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ touch: $json.request.touch, mode: "live", attempts: $json.http.attempt })' });
  L('Persisted', { step: 'state_updated', detail: '({ status: $json.persist.status, step: $json.persist.step, next: $json.persist.next_touch_at, fields: $json.persist.custom_fields })' });
  L('Capture Custom Fields', { step: 'ghl_custom_fields', status: "$json.cf.ok ? 'ok' : 'failed'", error: "$json.cf.error ?? ''" });
  L('Build Result', { step: 'completed', status: "$json.result.status === 'sent' ? 'ok' : ($json.result.status === 'blocked' ? 'skipped' : 'failed')", error: "$json.result.status === 'sent' ? '' : $json.result.status", detail: '({ result: $json.result })' });

  w.note('## Revival · Send Touch (uno por lead)\nGuarda en el momento del envío (lote aprobado, sin baja, orden de toques) → idempotencia → mensaje personalizado → validación y pie de baja → envío → estado + custom fields.', [col(0) - 20, -330], col(13), 130)
   .note('### Log por paso → Postgres\nNodos "Log · …" y "Side · …": ramas laterales.', [col(0) - 20, 760], 480, 90);

  // ── Conexiones ──
  w.link('Touch Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load Guard', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load Guard', 'Guard Result').link('Guard Result', 'Can Send?')
   .link('Can Send?', 'Claim Idempotency', 0).link('Can Send?', 'Respond 409 (blocked)', 1)
   .link('Respond 409 (blocked)', 'Side · Record Block')
   .link('New touch?', 'Accepted 202', 0).link('New touch?', 'Duplicate 200', 1)
   .link('Accepted 202', 'AI Mode?')
   .link('AI Mode?', 'Build Touch Request', 0).link('AI Mode?', 'Mock Touch', 1)
   .link('Build Touch Request', 'Claude Touch').link(claudeExit, 'Parse Touch', 1)
   .link('Parse Touch', 'Compose Message').link('Mock Touch', 'Compose Message')
   .link('Compose Message', 'Message OK?')
   .link('Message OK?', 'Send Mode?', 0).link('Message OK?', 'Block Message', 1)
   .link('Block Message', 'Blocked Result').link('Blocked Result', 'Build Result')
   .link('Send Mode?', 'GHL Send Message', 0).link('Send Mode?', 'Send Touch (mock email)', 1)
   .link('Send Touch (mock email)', 'Capture Mock Send').link(sendExit, 'Capture Live Send', 1)
   .link('Capture Mock Send', 'Sent OK?').link('Capture Live Send', 'Sent OK?')
   .link('Sent OK?', 'Prepare Persist', 0).link('Sent OK?', 'Build Result', 1)
   .link('Prepare Persist', 'Persist Touch').link('Persist Touch', 'Persisted').link('Persisted', 'CF Mode?')
   .link('CF Mode?', 'GHL Custom Fields', 0).link('CF Mode?', 'Build Result', 1)
   .link(cfExit, 'Capture Custom Fields', 1).link('Capture Custom Fields', 'Build Result')
   .link('Build Result', 'Mark Idempotency').link('Build Result', 'Assert Touch');

  return { file: 'revival-touch.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
