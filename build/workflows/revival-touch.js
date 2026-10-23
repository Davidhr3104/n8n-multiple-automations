const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-touch';
const col = n => n * 240;

module.exports = function revivalTouch() {
  const w = Workflow('revivaltouch0001', 'Revival · Send Touch (Auditable)');

  // ── Entrada + validación ──
  w.add('Touch Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'revival-touch', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Envía UN borrador ya aprobado por el dueño. Lo llaman la página de revisión y la cola de envío. Protegido por x-revival-token + guarda.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-revival-token'] !== c.internalToken) errors.push('bad_token');
if (!Number.isInteger(b.draft_id)) errors.push('draft_id');
return { json: { request: { draft_id: b.draft_id }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 700], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Guarda: se evalúa AQUÍ, en el momento del envío ──
  pg(w, 'Load Guard', [col(4), 200],
    `SELECT d.id AS draft_id, d.batch_id, d.contact_id, d.touch, d.status AS draft_status, d.body,
       c.name, c.email, c.phone, c.company, c.timezone,
       b.status AS batch_status,
       COALESCE(s.step, 0) AS step, COALESCE(s.status, 'new') AS state_status,
       EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(c.email) OR x.key = norm_phone(c.phone, '57')) AS suppressed
FROM revival_drafts d
JOIN revival_contacts c ON c.contact_id = d.contact_id
JOIN revival_batches b ON b.batch_id = d.batch_id
LEFT JOIN revival_state s ON s.contact_id = d.contact_id
WHERE d.id = $1`,
    '[$json.request.draft_id]', { alwaysOutputData: true, notes: 'Borrador + lote + estado + lista de bajas en una sola consulta.' });
  w.add('Guard Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(
    [{ file: 'revival', exports: ['canSendDraft'] }],
    `const s = $('Validate Request').item.json;
const row = $input.item.json.draft_id ? $input.item.json : null;
const guard = canSendDraft(row, row ? Number(row.touch) : NaN, s.config);
const draft = row ? { id: Number(row.draft_id), batch_id: row.batch_id, contact_id: row.contact_id, touch: Number(row.touch), body: row.body, status: row.draft_status } : null;
const contact = row ? { contact_id: row.contact_id, name: row.name, email: row.email, phone: row.phone, company: row.company, timezone: row.timezone } : null;
return { json: { ...s, draft, contact, guard: { ...guard, row: row ? { draft_status: row.draft_status, batch_status: row.batch_status, state_status: row.state_status, step: row.step, suppressed: row.suppressed } : null } } };`)),
    { notes: 'DETERMINÍSTICO: borrador aprobado, lote aprobado, sin baja, estado válido y toque en orden. No confía en quien llama.' })
   .add('Can Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.guard.ok }}'));
  respond(w, 'Respond 409 (blocked)', [col(7), 560], 409, '{ status: "blocked", reason: $json.guard.reason, draft_id: $json.request.draft_id }');
  pg(w, 'Side · Record Block', [col(8), 560],
    "INSERT INTO revival_messages (contact_id, touch, channel, body, status, batch_id, execution_id) SELECT d.contact_id, d.touch, 'n/a', $2, 'blocked', d.batch_id, $3 FROM revival_drafts d WHERE d.id = $1",
    "[$json.request.draft_id, 'blocked by guard: ' + $json.guard.reason, $execution.id]");

  // ── Horario de envío: solo en horario laboral LOCAL del contacto; si no, se difiere hasta que abra la ventana ──
  w.add('Check Window', 'n8n-nodes-base.code', 2, [col(7), 100], code(embed(
    [{ file: 'schedule', exports: ['inferTimezone', 'isWithinWindow', 'nextWindowOpen'] }],
    `const s = $input.item.json;
const info = inferTimezone({ timezone: s.contact.timezone, phone: s.contact.phone }, s.config);
const now = new Date().toISOString();
const open = isWithinWindow(now, info.tz, s.config.sendWindow);
const next = open ? null : nextWindowOpen(now, info.tz, s.config.sendWindow);
return { json: { ...s, window: { open, tz: info.tz, source: info.source, now, next, no_window: !open && next === null } } };`)),
    { notes: 'La zona se deduce (contacto > teléfono > por defecto) y la fuente se registra. Fuera de horario NO se envía: queda diferido con la hora en que abre la ventana.' })
   .add('Window Open?', 'n8n-nodes-base.if', 2.2, [col(8), 100], ifBool('={{ $json.window.open }}'));
  pg(w, 'Defer Draft', [col(9), 360],
    `UPDATE revival_drafts SET status = CASE WHEN NULLIF($2, '') IS NULL THEN 'blocked' ELSE 'deferred' END,
  reason = CASE WHEN NULLIF($2, '') IS NULL THEN 'no_send_window' ELSE reason END,
  send_after = NULLIF($2, '')::timestamptz, tz = $3, tz_source = $4
WHERE id = $1 AND status IN ('approved', 'deferred') RETURNING id`,
    "[$json.draft.id, $json.window.next || '', $json.window.tz, $json.window.source]",
    { alwaysOutputData: true, notes: 'Fuera de horario: el borrador queda "deferred" con send_after. La cola (Send Queue) lo libera cuando abre la ventana.' });
  w.add('Deferred Saved', 'n8n-nodes-base.code', 2, [col(10), 360], code(`return { json: { ...$('Check Window').item.json } };`));
  respond(w, 'Respond Deferred', [col(11), 360], 202, '{ status: $json.window.no_window ? "blocked" : "deferred", draft_id: $json.draft.id, send_after: $json.window.next, tz: $json.window.tz }');

  idempotency(w, {
    workflow: WF, position: [col(9), 100], paramCount: 2, params: '$json.draft.contact_id, String($json.draft.touch)', stateFrom: 'Check Window', check: 'New send?',
    keySql: "'revival-send:' || $1 || ':' || $2",
  });
  respond(w, 'Accepted 202', [col(12), 0], 202, '{ status: "accepted", draft_id: $json.draft.id, contact_id: $json.draft.contact_id, touch: $json.draft.touch }');
  respond(w, 'Duplicate 200', [col(12), 260], 200, '{ status: "duplicate", draft_id: $json.draft.id, contact_id: $json.draft.contact_id, touch: $json.draft.touch }');

  // ── Envío: mock (email local) o live (GHL) ──
  w.add('Send Mode?', 'n8n-nodes-base.if', 2.2, [col(13), 0], ifEquals('={{ $json.config.crmMode }}', 'live'))
   .add('Send Touch (mock email)', 'n8n-nodes-base.emailSend', 2.1, [col(14), 200], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.contact.email }}',
    subject: 'Following up',
    emailFormat: 'text',
    text: '={{ $json.draft.body }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA simulada: el email llega a Mailpit. Solo se llega aquí con borrador aprobado + guarda OK + dentro de horario.' })
   .add('Capture Mock Send', 'n8n-nodes-base.code', 2, [col(15), 200], code(
    `const s = $('Send Mode?').item.json;
const r = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'mock', error: JSON.stringify(r.error) } : { ok: true, mode: 'mock' } } };`));

  const sendExit = httpWithBackoff(w, {
    name: 'GHL Send Message', position: [col(14), -80], source: 'Send Mode?', workflow: WF, entity: '$json.draft.contact_id',
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
      jsonBody: "={{ JSON.stringify({ type: 'SMS', contactId: $json.contact.contact_id, message: $json.draft.body }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Live Send', 'n8n-nodes-base.code', 2, [col(17), -80], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'live', error: JSON.stringify(r.error) } : { ok: true, mode: 'live', response: r } } };`))
   .add('Sent OK?', 'n8n-nodes-base.if', 2.2, [col(18), 100], ifBool('={{ $json.send.ok }}'));

  pg(w, 'Mark Draft Failed', [col(19), 420],
    "UPDATE revival_drafts SET status = 'failed', reason = $2 WHERE id = $1 RETURNING id",
    "[$json.draft.id, 'send_failed: ' + String($json.send.error).slice(0, 300)]");
  w.add('Failed Marked', 'n8n-nodes-base.code', 2, [col(20), 420], code(`return { json: { ...$('Sent OK?').item.json } };`));

  // ── Persistencia: estado + mensaje + custom fields + borrador "sent" (una sola sentencia atómica) ──
  w.add('Prepare Persist', 'n8n-nodes-base.code', 2, [col(19), 0], code(embed(
    [{ file: 'revival', exports: ['nextTouchAt'] }],
    `const s = $input.item.json;
const now = new Date().toISOString();
const touch = s.draft.touch;
const next = nextTouchAt(touch, s.config, now);
const done = touch >= s.config.maxTouches;
return { json: { ...s, persist: {
  status: done ? 'completed' : 'active',
  step: touch,
  next_touch_at: next || '',
  custom_fields: { revival_stage: done ? 'sequence_completed' : 'touch_' + touch + '_sent', revival_touch_count: String(touch), revival_last_touch_at: now },
} } };`)))
   .add('Persist Touch', 'n8n-nodes-base.postgres', 2.6, [col(20), 0], {
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
), dr AS (
  UPDATE revival_drafts SET status = 'sent', sent_at = now() WHERE id = $9::bigint RETURNING id
)
SELECT (SELECT count(*) FROM st) AS state_rows, (SELECT count(*) FROM msg) AS message_rows, (SELECT count(*) FROM cf) AS field_rows, (SELECT count(*) FROM dr) AS draft_rows`,
    options: { queryReplacement: "={{ [$json.draft.contact_id, $json.persist.status, String($json.persist.step), $json.persist.next_touch_at, $json.draft.batch_id, $json.draft.body, $execution.id, JSON.stringify($json.persist.custom_fields), String($json.draft.id)] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, notes: 'Estado, mensaje, custom fields y borrador "sent" en UNA sentencia: o se guarda todo o nada.' })
   .add('Persisted', 'n8n-nodes-base.code', 2, [col(21), 0], code(
    `const s = $('Prepare Persist').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1 || Number(r.message_rows) !== 1 || Number(r.draft_rows) !== 1) throw new Error('Persist touch wrote unexpected rows for ' + s.draft.contact_id + ': ' + JSON.stringify(r));
return { json: { ...s, persisted: { ok: true, rows: r } } };`))
   .add('CF Mode?', 'n8n-nodes-base.if', 2.2, [col(22), 0], ifEquals('={{ $json.config.crmMode }}', 'live'));

  const cfExit = httpWithBackoff(w, {
    name: 'GHL Custom Fields', position: [col(23), -160], source: 'CF Mode?', workflow: WF, entity: '$json.draft.contact_id',
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
  w.add('Capture Custom Fields', 'n8n-nodes-base.code', 2, [col(26), -160], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, cf: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(27), 200], code(
    `const s = $input.item.json;
let status = 'sent';
if (s.send && !s.send.ok) status = 'send_failed';
else if (s.cf && !s.cf.ok) status = 'custom_fields_failed';
return { json: { ...s, result: { status, touch: s.draft.touch, contact_id: s.draft.contact_id, draft_id: s.draft.id } } };`),
    { notes: 'Todas las rutas con envío terminan aquí: enviado, envío fallido o custom fields fallidos.' });
  markIdempotency(w, {
    position: [col(28), 40], keyExpr: '$json.idem.key',
    statusExpr: "['send_failed', 'custom_fields_failed'].includes($json.result.status) ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status, draft_id: $json.result.draft_id })',
  });
  w.add('Assert Touch', 'n8n-nodes-base.code', 2, [col(28), 200], code(
    `const s = $input.item.json;
const r = s.result;
if (r.status === 'send_failed') throw new Error('Touch ' + r.touch + ' to ' + r.contact_id + ': sending failed: ' + s.send.error + '. The draft was marked failed and the contact state is unchanged.');
if (r.status === 'custom_fields_failed') throw new Error('Touch ' + r.touch + ' sent to ' + r.contact_id + ' but updating custom fields failed: ' + s.cf.error);
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.draft ? $json.draft.contact_id : $json.request.draft_id', ...o });
  L('Validate Request', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ draft_id: $json.request.draft_id })' });
  L('Guard Result', { step: 'guard_checked', status: "$json.guard.ok ? 'ok' : 'skipped'", error: "$json.guard.ok ? '' : $json.guard.reason", detail: '({ draft_id: $json.request.draft_id, guard: $json.guard.row })' });
  L('Check Window', { step: 'window_checked', status: "$json.window.open ? 'ok' : 'waiting'", error: "$json.window.no_window ? 'no_send_window' : ''", detail: '({ open: $json.window.open, tz: $json.window.tz, source: $json.window.source, next: $json.window.next })' });
  L('Idempotency Result', { step: 'send_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'", detail: '({ touch: $json.draft.touch })' });
  L('Capture Mock Send', { step: 'touch_sent', name: 'Log · touch_sent (mock)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ touch: $json.draft.touch, mode: "mock" })' });
  L('Capture Live Send', { step: 'touch_sent', name: 'Log · touch_sent (live)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ touch: $json.draft.touch, mode: "live", attempts: $json.http.attempt })' });
  L('Persisted', { step: 'state_updated', detail: '({ status: $json.persist.status, step: $json.persist.step, next: $json.persist.next_touch_at, fields: $json.persist.custom_fields })' });
  L('Capture Custom Fields', { step: 'ghl_custom_fields', status: "$json.cf.ok ? 'ok' : 'failed'", error: "$json.cf.error ?? ''" });
  L('Build Result', { step: 'completed', status: "$json.result.status === 'sent' ? 'ok' : 'failed'", error: "$json.result.status === 'sent' ? '' : $json.result.status", detail: '({ result: $json.result })' });

  w.note('## Revival · Send Touch (one approved draft)\nSend-time guard → sending hours (local to the contact) → idempotency → send → state + custom fields. Outside hours the draft is deferred, not sent.', [col(0) - 20, -330], col(12), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches.', [col(0) - 20, 860], 480, 90);

  // ── Conexiones ──
  w.link('Touch Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load Guard', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load Guard', 'Guard Result').link('Guard Result', 'Can Send?')
   .link('Can Send?', 'Check Window', 0).link('Can Send?', 'Respond 409 (blocked)', 1)
   .link('Respond 409 (blocked)', 'Side · Record Block')
   .link('Check Window', 'Window Open?')
   .link('Window Open?', 'Claim Idempotency', 0).link('Window Open?', 'Defer Draft', 1)
   .link('Defer Draft', 'Deferred Saved').link('Deferred Saved', 'Respond Deferred')
   .link('New send?', 'Accepted 202', 0).link('New send?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Send Mode?')
   .link('Send Mode?', 'GHL Send Message', 0).link('Send Mode?', 'Send Touch (mock email)', 1)
   .link('Send Touch (mock email)', 'Capture Mock Send').link(sendExit, 'Capture Live Send', 1)
   .link('Capture Mock Send', 'Sent OK?').link('Capture Live Send', 'Sent OK?')
   .link('Sent OK?', 'Prepare Persist', 0).link('Sent OK?', 'Mark Draft Failed', 1)
   .link('Mark Draft Failed', 'Failed Marked').link('Failed Marked', 'Build Result')
   .link('Prepare Persist', 'Persist Touch').link('Persist Touch', 'Persisted').link('Persisted', 'CF Mode?')
   .link('CF Mode?', 'GHL Custom Fields', 0).link('CF Mode?', 'Build Result', 1)
   .link(cfExit, 'Capture Custom Fields', 1).link('Capture Custom Fields', 'Build Result')
   .link('Build Result', 'Mark Idempotency').link('Build Result', 'Assert Touch');

  return { file: 'revival-touch.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
