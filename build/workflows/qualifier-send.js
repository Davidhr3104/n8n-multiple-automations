const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { QUALIFIER } = require('./qualifier-config');

const WF = 'qualifier-send';
const col = n => n * 240;

module.exports = function qualifierSend() {
  const w = Workflow('qualifiersend001', 'Qualifier · Send Message (Auditable)');

  // ── Entrada + validación ──
  w.add('Send Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'qualifier-send', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Envía UN mensaje de la cola de salida (qualifier_outbox). Lo llaman Inbound, Booking y la cola. Protegido por x-qualifier-token + guarda.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: QUALIFIER }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-qualifier-token'] !== c.internalToken) errors.push('bad_token');
if (!Number.isInteger(b.outbox_id)) errors.push('outbox_id');
return { json: { request: { outbox_id: b.outbox_id }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 700], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Guarda al enviar: se evalúa AQUÍ, no se confía en quien llama ──
  pg(w, 'Load Guard', [col(4), 200],
    `SELECT o.id AS outbox_id, o.contact_id, o.kind, o.body, o.status AS outbox_status,
       s.status AS state_status, s.name, s.phone, s.email, s.timezone,
       EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(s.email) OR x.key = norm_phone(s.phone, '57')) AS suppressed
FROM qualifier_outbox o JOIN conversation_state s ON s.contact_id = o.contact_id
WHERE o.id = $1`,
    '[$json.request.outbox_id]', { alwaysOutputData: true });
  w.add('Guard Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Validate Request').item.json;
const row = $input.item.json.outbox_id ? $input.item.json : null;
let reason = null;
if (!row) reason = 'no_outbox_row';
else if (row.suppressed || row.state_status === 'dnc') reason = 'suppressed';
else if (row.outbox_status !== 'pending') reason = 'outbox_' + row.outbox_status;
else if (row.kind === 'followup' && row.state_status !== 'active') reason = 'conversation_not_active';
const message = row ? { id: Number(row.outbox_id), contact_id: row.contact_id, kind: row.kind, body: row.body } : null;
const contact = row ? { contact_id: row.contact_id, name: row.name, phone: row.phone, email: row.email, timezone: row.timezone } : null;
return { json: { ...s, message, contact, guard: { ok: reason === null, reason, row: row ? { outbox_status: row.outbox_status, state_status: row.state_status, suppressed: row.suppressed } : null } } };`),
    { notes: 'DETERMINÍSTICO: mensaje pendiente, lead sin baja (se consulta la lista otra vez) y conversación en un estado que admite ese tipo de mensaje.' })
   .add('Can Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.guard.ok }}'));
  respond(w, 'Respond 409 (blocked)', [col(7), 560], 409, '{ status: "blocked", reason: $json.guard.reason, outbox_id: $json.request.outbox_id }');
  pg(w, 'Side · Record Block', [col(8), 560],
    "UPDATE qualifier_outbox SET status = 'blocked', reason = $2 WHERE id = $1 AND status = 'pending'",
    "[$json.request.outbox_id, $json.guard.reason]");

  // ── Horario: solo en horario laboral LOCAL del lead. La confirmación de una cita ya agendada es transaccional y sale siempre ──
  w.add('Check Window', 'n8n-nodes-base.code', 2, [col(7), 100], code(embed(
    [{ file: 'schedule', exports: ['inferTimezone', 'isWithinWindow', 'nextWindowOpen'] }],
    `const s = $input.item.json;
const info = inferTimezone({ timezone: s.contact.timezone, phone: s.contact.phone }, s.config);
const now = new Date().toISOString();
const transactional = s.message.kind === 'confirmation';
const open = transactional || isWithinWindow(now, info.tz, s.config.sendWindow);
const next = open ? null : nextWindowOpen(now, info.tz, s.config.sendWindow);
return { json: { ...s, window: { open, transactional, tz: info.tz, source: info.source, now, next, no_window: !open && next === null } } };`)),
    { notes: 'Zona del lead > prefijo del teléfono > por defecto (la fuente se registra).' })
   .add('Window Open?', 'n8n-nodes-base.if', 2.2, [col(8), 100], ifBool('={{ $json.window.open }}'));
  pg(w, 'Defer Message', [col(9), 360],
    `UPDATE qualifier_outbox SET send_after = COALESCE(NULLIF($2, '')::timestamptz, send_after),
  status = CASE WHEN NULLIF($2, '') IS NULL THEN 'blocked' ELSE status END,
  reason = CASE WHEN NULLIF($2, '') IS NULL THEN 'no_send_window' ELSE 'outside_sending_hours' END, tz = $3, tz_source = $4
WHERE id = $1 AND status = 'pending' RETURNING id`,
    "[$json.message.id, $json.window.next || '', $json.window.tz, $json.window.source]",
    { alwaysOutputData: true, notes: 'Fuera de horario: el mensaje sigue "pending" con send_after = apertura de la ventana. La cola de Stale & Queue lo libera.' });
  w.add('Deferred Saved', 'n8n-nodes-base.code', 2, [col(10), 360], code(`return { json: { ...$('Check Window').item.json } };`));
  respond(w, 'Respond Deferred', [col(11), 360], 202, '{ status: $json.window.no_window ? "blocked" : "deferred", outbox_id: $json.message.id, send_after: $json.window.next, tz: $json.window.tz }');

  idempotency(w, {
    workflow: WF, position: [col(9), 100], paramCount: 1, params: 'String($json.message.id)', stateFrom: 'Check Window', check: 'New send?',
    keySql: "'qualifier-send:' || $1",
  });
  respond(w, 'Accepted 202', [col(13), 0], 202, '{ status: "accepted", outbox_id: $json.message.id, contact_id: $json.message.contact_id }');
  respond(w, 'Duplicate 200', [col(13), 260], 200, '{ status: "duplicate", outbox_id: $json.message.id }');

  // ── Envío: mock (email local que simula el SMS) o live (GHL) ──
  w.add('Send Mode?', 'n8n-nodes-base.if', 2.2, [col(14), 0], ifEquals('={{ $json.config.crmMode }}', 'live'))
   .add('Send SMS (mock email)', 'n8n-nodes-base.emailSend', 2.1, [col(15), 200], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: "={{ $json.contact.email || 'sms-mock@localhost' }}",
    subject: "={{ 'SMS to ' + ($json.contact.phone || $json.contact.contact_id) }}",
    emailFormat: 'text',
    text: '={{ $json.message.body }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA simulada: el "SMS" llega como email a Mailpit. Solo se llega aquí con guarda OK + dentro de horario.' })
   .add('Capture Mock Send', 'n8n-nodes-base.code', 2, [col(16), 200], code(
    `const s = $('Send Mode?').item.json;
const r = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'mock', error: JSON.stringify(r.error) } : { ok: true, mode: 'mock' } } };`));

  const sendExit = httpWithBackoff(w, {
    name: 'GHL Send Message', position: [col(15), -80], source: 'Send Mode?', workflow: WF, entity: '$json.message.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint/cuerpo de conversations/messages SIN verificar contra la API real.',
    params: {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/conversations/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-04-15' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ type: 'SMS', contactId: $json.contact.contact_id, message: $json.message.body }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Live Send', 'n8n-nodes-base.code', 2, [col(18), -80], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'live', error: JSON.stringify(r.error) } : { ok: true, mode: 'live', response: r } } };`))
   .add('Sent OK?', 'n8n-nodes-base.if', 2.2, [col(19), 100], ifBool('={{ $json.send.ok }}'));

  pg(w, 'Mark Failed', [col(20), 420],
    "UPDATE qualifier_outbox SET status = 'failed', reason = $2 WHERE id = $1 RETURNING id",
    "[$json.message.id, 'send_failed: ' + String($json.send.error).slice(0, 300)]");
  w.add('Failed Marked', 'n8n-nodes-base.code', 2, [col(21), 420], code(`return { json: { ...$('Sent OK?').item.json } };`));

  // ── Persistencia atómica: mensaje enviado + log de la conversación + estado ──
  pg(w, 'Persist Sent', [col(20), 0],
    `WITH o AS (
  UPDATE qualifier_outbox SET status = 'sent', sent_at = now(), tz = $3, tz_source = $4, execution_id = $5 WHERE id = $1 AND status = 'pending' RETURNING id
), m AS (
  INSERT INTO messages_log (message_id, contact_id, direction, body, execution_id) VALUES ('out:' || $1, $2, 'out', $6, $5) ON CONFLICT (message_id) DO NOTHING RETURNING id
), st AS (
  UPDATE conversation_state SET last_outbound_at = now(), updated_at = now(),
    followup_sent_at = CASE WHEN $7 = 'followup' THEN now() ELSE followup_sent_at END
  WHERE contact_id = $2 RETURNING contact_id
)
SELECT (SELECT count(*) FROM o) AS outbox_rows, (SELECT count(*) FROM m) AS log_rows, (SELECT count(*) FROM st) AS state_rows`,
    '[String($json.message.id), $json.message.contact_id, $json.window.tz, $json.window.source, $execution.id, $json.message.body, $json.message.kind]',
    { notes: 'Outbox, log de la conversación y estado en UNA sentencia: o se guarda todo o nada.' });
  w.add('Persisted', 'n8n-nodes-base.code', 2, [col(21), 0], code(
    `const s = $('Sent OK?').item.json;
const r = $input.item.json;
if (Number(r.outbox_rows) !== 1 || Number(r.state_rows) !== 1) throw new Error('Persist sent wrote unexpected rows for outbox ' + s.message.id + ': ' + JSON.stringify(r));
return { json: { ...s, persisted: { ok: true, rows: r } } };`));

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(22), 200], code(
    `const s = $input.item.json;
const status = s.send && !s.send.ok ? 'send_failed' : 'sent';
return { json: { ...s, result: { status, outbox_id: s.message.id, contact_id: s.message.contact_id, kind: s.message.kind } } };`));
  markIdempotency(w, {
    position: [col(23), 40], keyExpr: '$json.idem.key',
    statusExpr: "$json.result.status === 'sent' ? 'done' : 'failed'",
    resultExpr: '({ status: $json.result.status, outbox_id: $json.result.outbox_id })',
  });
  w.add('Assert Send', 'n8n-nodes-base.code', 2, [col(23), 200], code(
    `const s = $input.item.json;
if (s.result.status === 'send_failed') throw new Error('Message ' + s.result.outbox_id + ' to ' + s.result.contact_id + ': sending failed: ' + s.send.error + '. It was marked failed; the conversation state is unchanged.');
return { json: s.result };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar estado y log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.message ? $json.message.contact_id : $json.request.outbox_id', ...o });
  L('Validate Request', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ outbox_id: $json.request.outbox_id })' });
  L('Guard Result', { step: 'guard_checked', status: "$json.guard.ok ? 'ok' : 'skipped'", error: "$json.guard.ok ? '' : $json.guard.reason", detail: '({ outbox_id: $json.request.outbox_id, guard: $json.guard.row })' });
  L('Check Window', { step: 'window_checked', status: "$json.window.open ? 'ok' : 'waiting'", error: "$json.window.no_window ? 'no_send_window' : ''", detail: '({ open: $json.window.open, transactional: $json.window.transactional, tz: $json.window.tz, source: $json.window.source, next: $json.window.next })' });
  L('Capture Mock Send', { step: 'message_sent', name: 'Log · message_sent (mock)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ kind: $json.message.kind, mode: "mock" })' });
  L('Capture Live Send', { step: 'message_sent', name: 'Log · message_sent (live)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ kind: $json.message.kind, mode: "live" })' });
  L('Build Result', { step: 'completed', status: "$json.result.status === 'sent' ? 'ok' : 'failed'", error: "$json.result.status === 'sent' ? '' : $json.result.status", detail: '({ result: $json.result })' });

  w.note('## Qualifier · Send Message (one outbox message)\nSend-time guard (opt-outs re-checked) → sending hours in the lead\'s local time → idempotency → send → outbox + conversation log. Outside hours the message waits for the window to open.', [col(0) - 20, -330], col(12), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches.', [col(0) - 20, 860], 480, 90);

  // ── Conexiones ──
  w.link('Send Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load Guard', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load Guard', 'Guard Result').link('Guard Result', 'Can Send?')
   .link('Can Send?', 'Check Window', 0).link('Can Send?', 'Respond 409 (blocked)', 1)
   .link('Respond 409 (blocked)', 'Side · Record Block')
   .link('Check Window', 'Window Open?')
   .link('Window Open?', 'Claim Idempotency', 0).link('Window Open?', 'Defer Message', 1)
   .link('Defer Message', 'Deferred Saved').link('Deferred Saved', 'Respond Deferred')
   .link('New send?', 'Accepted 202', 0).link('New send?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Send Mode?')
   .link('Send Mode?', 'GHL Send Message', 0).link('Send Mode?', 'Send SMS (mock email)', 1)
   .link('Send SMS (mock email)', 'Capture Mock Send').link(sendExit, 'Capture Live Send', 1)
   .link('Capture Mock Send', 'Sent OK?').link('Capture Live Send', 'Sent OK?')
   .link('Sent OK?', 'Persist Sent', 0).link('Sent OK?', 'Mark Failed', 1)
   .link('Mark Failed', 'Failed Marked').link('Failed Marked', 'Build Result')
   .link('Persist Sent', 'Persisted').link('Persisted', 'Build Result')
   .link('Build Result', 'Mark Idempotency').link('Build Result', 'Assert Send');

  return { file: 'qualifier-send.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
