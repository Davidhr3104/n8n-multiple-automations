const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { PAY } = require('./pay-config');

const WF = 'pay-reply';
const col = n => n * 240;
const L = exports_ => [{ file: 'schedule', exports: [] }, { file: 'payments', exports: exports_ }];

const ANTHROPIC_PARAMS = jsonBody => ({
  method: 'POST',
  url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true, specifyBody: 'json', jsonBody, options: { timeout: 60000 },
});

const CONTEXT_SQL = `SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_id', invoice_id, 'promise_count', promise_count, 'customer_name', customer_name) ORDER BY due_date, invoice_id), '[]'::jsonb) AS invoices
FROM pay_invoices WHERE lower(contact_email) = $1 AND status = 'open'`;

// Un solo efecto por respuesta, en UNA sentencia. La baja entra a la lista compartida; disputa y promesa cambian solo las facturas abiertas del contacto.
// "Ya pagué" NUNCA marca nada como pagado: solo pausa unos días.
const APPLY_SQL = `WITH d AS (SELECT $1::jsonb AS j),
inv AS (SELECT invoice_id FROM pay_invoices WHERE lower(contact_email) = (SELECT j->>'from' FROM d) AND status = 'open'),
o AS (INSERT INTO suppression_list (key, reason, source) SELECT j->>'from', 'opt_out', 'payments' FROM d WHERE j->>'effect' = 'optout' ON CONFLICT (key) DO NOTHING RETURNING key),
pc AS (UPDATE pay_invoices i SET paused_until = (d.j->>'until')::timestamptz, updated_at = now(), version = i.version + 1 FROM d WHERE d.j->>'effect' = 'paid_claim' AND i.invoice_id IN (SELECT invoice_id FROM inv) RETURNING i.invoice_id),
pr AS (UPDATE pay_invoices i SET paused_until = (d.j->>'until')::timestamptz, promise_count = i.promise_count + 1, updated_at = now(), version = i.version + 1 FROM d WHERE d.j->>'effect' = 'promise' AND i.invoice_id IN (SELECT invoice_id FROM inv) RETURNING i.invoice_id),
ds AS (UPDATE pay_invoices i SET status = 'disputed', updated_at = now(), version = i.version + 1 FROM d WHERE d.j->>'effect' = 'dispute' AND i.invoice_id IN (SELECT invoice_id FROM inv) RETURNING i.invoice_id),
e AS (INSERT INTO pay_events (invoice_id, event, actor, detail)
      SELECT invoice_id, ev, 'customer', det FROM (
        SELECT invoice_id, 'paid_claim' AS ev, jsonb_build_object('paused_until', (SELECT j->>'until' FROM d)) AS det FROM pc
        UNION ALL SELECT invoice_id, 'promise_to_pay', jsonb_build_object('date', (SELECT j->>'date' FROM d)) FROM pr
        UNION ALL SELECT invoice_id, 'disputed', '{}'::jsonb FROM ds
        UNION ALL SELECT invoice_id, 'opted_out', '{}'::jsonb FROM inv WHERE (SELECT j->>'effect' FROM d) = 'optout'
        UNION ALL SELECT invoice_id, 'reply_handoff', jsonb_build_object('reason', (SELECT j->>'handoff' FROM d)) FROM inv WHERE (SELECT j->>'effect' FROM d) = 'handoff') q RETURNING id)
SELECT (SELECT count(*) FROM o) AS opted_out, (SELECT count(*) FROM pc) AS paid_claims, (SELECT count(*) FROM pr) AS promises, (SELECT count(*) FROM ds) AS disputed`;

module.exports = function payReply() {
  const w = Workflow('payreply00000001', 'Payments · Customer Reply (Auditable)');

  // ── Entrada + validación + idempotencia ──
  w.add('Reply Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 520],
    { httpMethod: 'POST', path: 'pay-reply', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Respuesta del cliente: {message_id, from, text}. En live la dispara el correo / SMS entrante. Idempotente por message_id. Protegido por x-pay-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 520], { mode: 'raw', jsonOutput: JSON.stringify({ config: PAY }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Reply', 'n8n-nodes-base.code', 2, [col(2), 520], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body && typeof item.body === 'object' ? item.body : {};
const str = k => (typeof b[k] === 'string' ? b[k].trim() : '');
const errors = [];
const reply = { message_id: str('message_id'), from: str('from').toLowerCase(), text: str('text') };
if (!/^[A-Za-z0-9_-]{1,64}$/.test(reply.message_id)) errors.push('message_id');
if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(reply.from)) errors.push('from');
if (!reply.text || reply.text.length > 2000) errors.push('text');
let now = new Date().toISOString();
if (b.now !== undefined && b.now !== '') {
  if (!c.allowTimeOverride) errors.push('time_override_not_allowed');
  else if (typeof b.now !== 'string' || !Number.isFinite(Date.parse(b.now))) errors.push('now');
  else now = new Date(b.now).toISOString();
}
if (!item.headers || item.headers['x-pay-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { reply, now, validation: { ok: errors.length === 0, errors }, config: c } };`),
    { notes: 'DETERMINÍSTICO: id, remitente y texto válidos. "now" solo en mock con token.' })
   .add('Valid Reply?', 'n8n-nodes-base.if', 2.2, [col(3), 520], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1500], 400, '{ status: "rejected", errors: $json.validation.errors }');
  idempotency(w, { workflow: WF, position: [col(4), 420], paramCount: 1, params: '$json.reply.message_id', stateFrom: 'Normalize Reply', check: 'New reply?', keySql: "'pay-reply:' || $1" });
  respond(w, 'Duplicate 200', [col(7), 720], 200, '{ status: "duplicate", message_id: $json.reply.message_id }');
  respond(w, 'Accepted 202', [col(7), 420], 202, '{ status: "accepted", message_id: $json.reply.message_id }');

  // ── Contexto + baja e inyección por código, ANTES de la IA ──
  pg(w, 'Load Invoices', [col(8), 420], CONTEXT_SQL, '[$json.reply.from]', { alwaysOutputData: true, notes: 'Facturas abiertas de ese contacto.' });
  w.add('Prepare Reply', 'n8n-nodes-base.code', 2, [col(9), 420], code(embed(L(['optOut', 'injectionCheck']),
    `const s = $('Idempotency Result').item.json;
const invoices = $input.item.json.invoices || [];
const needs_ai = !optOut(s.reply.text) && invoices.length > 0 && !injectionCheck(s.reply.text);
return { json: { ...s, invoices, needs_ai } };`)),
    { notes: 'DETERMINÍSTICO: STOP y "unsubscribe" los lee el código. Un contacto sin facturas abiertas o un texto que da órdenes al sistema nunca llegan a la IA.' })
   .add('Needs AI?', 'n8n-nodes-base.if', 2.2, [col(10), 420], ifBool('={{ $json.needs_ai }}'))
   .add('No AI', 'n8n-nodes-base.code', 2, [col(11), 700], code(
    `const s = $input.item.json;
return { json: { ...s, classify_result: null } };`))
   .add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(11), 300], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Classify Request', 'n8n-nodes-base.code', 2, [col(12), 160], code(embed(L(['buildClassifyRequest']),
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClassifyRequest(s.reply.text, s.config.model) } };`)),
    { notes: 'La respuesta va dentro de <reply>: es DATO, nunca instrucciones. La IA solo elige una intención y cita la frase.' })
   .add('Mock Classify', 'n8n-nodes-base.code', 2, [col(12), 440], code(embed(L(['mockClassify']),
    `const s = $input.item.json;
return { json: { ...s, classify_result: mockClassify(s.reply.text) } };`)),
    { notes: 'Sustituto local de Claude: palabras clave. [[mock:ai_down]] simula la caída del modelo.' });
  const clExit = httpWithBackoff(w, {
    name: 'Claude Classify', position: [col(13), 160], source: 'Build Classify Request', workflow: WF, entity: '$json.reply.message_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (tool record_reply_intent).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Classify', 'n8n-nodes-base.code', 2, [col(16), 160], code(embed(L(['parseClassify']),
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, classify_result: parseClassify(http_response) } };`)))

  // ── El código decide ──
   .add('Decide', 'n8n-nodes-base.code', 2, [col(17), 420], code(embed(L(['groundIntent', 'decideReply']),
    `const s = $input.item.json;
const r = s.classify_result;
let classification = null;
if (r) classification = r.ok ? groundIntent(r.result, s.reply.text) : { ok: false, error: r.error };
const decision = decideReply({ text: s.reply.text, now: s.now, classification, invoices: s.invoices }, s.config);
return { json: { ...s, classification, decision } };`)),
    { notes: 'DETERMINÍSTICO: baja → lista de bajas. Ya pagué → pausa y aviso (nunca marca pagado). No estoy de acuerdo → la factura pasa a disputada. Pagaré el… → la fecha la extrae el código (máx. 14 días, una vez). Todo lo demás → una persona. La evidencia de la IA debe estar en la respuesta.' });
  pg(w, 'Apply Effect', [col(18), 420], APPLY_SQL, "[JSON.stringify({ from: $json.reply.from, effect: $json.decision.effect, until: $json.decision.until || '', date: $json.decision.date || '', handoff: $json.decision.handoff || '' })]",
    { notes: 'Un solo efecto por respuesta, en UNA sentencia atómica.' });
  w.add('Plan Alert', 'n8n-nodes-base.code', 2, [col(19), 420], code(embed(L(['replyAlert']),
    `const s = $('Decide').item.json;
const e = s.decision.effect;
if (e === 'optout') return { json: { ...s, alert: null } };
const name = (s.invoices[0] && s.invoices[0].customer_name) || s.reply.from;
const m = replyAlert({ reason: e, customer_name: name, text: s.reply.text, invoices: s.invoices.map(i => i.invoice_id), detail: s.decision.handoff || '' });
return { json: { ...s, alert: { to: s.config.ownerEmail, subject: m.subject, text: m.text } } };`)),
    { notes: 'Toda respuesta que no sea una baja avisa a una persona con lo que escribió el cliente. Nada se contesta al cliente automáticamente.' })
   .add('Alert Needed?', 'n8n-nodes-base.if', 2.2, [col(20), 420], ifBool('={{ $json.alert !== null }}'))
   .add('Send Alert', 'n8n-nodes-base.emailSend', 2.1, [col(21), 320], {
    resource: 'email', operation: 'send', fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.alert.to }}', subject: '={{ $json.alert.subject }}',
    emailFormat: 'text', text: '={{ $json.alert.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local (en live: Slack / el correo de finanzas). El efecto ya quedó aplicado aunque el aviso falle: el fallo queda visible.' })
   .add('Final · alerted', 'n8n-nodes-base.code', 2, [col(22), 320], code(
    `const s = $('Plan Alert').item.json;
const r = $input.item.json;
const errors = r.error ? ['alert_email_failed: ' + JSON.stringify(r.error)] : [];
return { json: { ...s, result: { status: 'applied', message_id: s.reply.message_id, effect: s.decision.effect, handoff: s.decision.handoff || null, errors } } };`))
   .add('Final · no alert', 'n8n-nodes-base.code', 2, [col(21), 560], code(
    `const s = $input.item.json;
return { json: { ...s, result: { status: 'applied', message_id: s.reply.message_id, effect: s.decision.effect, handoff: null, errors: [] } } };`));
  markIdempotency(w, { position: [col(23), 380], keyExpr: '$json.idem.key', statusExpr: "'done'", resultExpr: '({ effect: $json.result.effect })' });
  w.add('Assert Reply', 'n8n-nodes-base.code', 2, [col(23), 560], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Payment reply ' + r.message_id + ' (' + r.effect + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log escritos → Error Handler.' });

  const G = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.reply.message_id', ...o });
  G('Normalize Reply', { step: 'reply_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  G('Idempotency Result', { step: 'reply_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  G('Decide', { step: 'decided', status: "$json.decision.effect === 'handoff' ? 'skipped' : 'ok'", error: "$json.decision.handoff || ''", detail: '({ effect: $json.decision.effect, intent: $json.classification ? $json.classification.intent : null, confidence: $json.classification ? $json.classification.confidence : null })' });
  G('Final · alerted', { step: 'completed', status: "$json.result.errors.length ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });
  G('Final · no alert', { step: 'completed', name: 'Log · completed (no alert)', detail: '({ result: $json.result })' });

  w.note('## Payments · Customer Reply\nA STOP is read by code. Everything else gets one AI classification (already paid / disputes / will pay on a date) with a quoted phrase that code verifies. Code decides: "already paid" never marks anything paid, a dispute stops the reminders, a promise date is extracted by code (max 14 days, once). Every reply that is not a STOP alerts a person; the customer is never answered automatically.', [col(0) - 20, -150], col(20), 130);

  w.link('Reply Webhook', 'Config').link('Config', 'Normalize Reply').link('Normalize Reply', 'Valid Reply?')
   .link('Valid Reply?', 'Claim Idempotency', 0).link('Valid Reply?', 'Respond 400', 1)
   .link('New reply?', 'Accepted 202', 0).link('New reply?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Load Invoices').link('Load Invoices', 'Prepare Reply').link('Prepare Reply', 'Needs AI?')
   .link('Needs AI?', 'AI Mode?', 0).link('Needs AI?', 'No AI', 1)
   .link('AI Mode?', 'Build Classify Request', 0).link('AI Mode?', 'Mock Classify', 1)
   .link('Build Classify Request', 'Claude Classify').link(clExit, 'Parse Classify', 1)
   .link('Parse Classify', 'Decide').link('Mock Classify', 'Decide').link('No AI', 'Decide')
   .link('Decide', 'Apply Effect').link('Apply Effect', 'Plan Alert').link('Plan Alert', 'Alert Needed?')
   .link('Alert Needed?', 'Send Alert', 0).link('Alert Needed?', 'Final · no alert', 1)
   .link('Send Alert', 'Final · alerted');
  for (const f of ['Final · alerted', 'Final · no alert']) w.link(f, 'Mark Idempotency').link(f, 'Assert Reply');

  return { file: 'pay-reply.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
