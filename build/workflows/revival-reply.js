const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-reply';
const col = n => n * 240;

// Datos del lead/CRM en emails de aprobación: se neutralizan & < > (n8n decodifica entidades HTML; verificado en 2.43.4).
const ESC = `const esc = v => String(v).replace(/&/g, "\\uFF06").replace(/</g, "\\u2039").replace(/>/g, "\\u203A");`;

// Cada ruta termina en un nodo "Outcome · …" que fija QUÉ se guarda; todos convergen en Persist Outcome.
const outcome = (resultName, fields) => `const s = $input.item.json;
const now = new Date().toISOString();
return { json: { ...s, outcome: { result: '${resultName}', ${fields} } } };`;

module.exports = function revivalReply() {
  const w = Workflow('revivalreply0001', 'Revival · Handle Reply (Auditable)');

  // ── Entrada + validación ──
  w.add('Reply Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'revival-reply', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Respuesta entrante del lead (en producción: el webhook de mensajes entrantes de GHL; su forma real está SIN verificar). Protegido por x-revival-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-revival-token'] !== c.internalToken) errors.push('bad_token');
if (typeof b.contact_id !== 'string' || !b.contact_id) errors.push('contact_id');
if (typeof b.message !== 'string' || !b.message.trim()) errors.push('message');
else if (b.message.length > 2000) errors.push('message_too_long');
return { json: { request: { contact_id: b.contact_id, message: typeof b.message === 'string' ? b.message.trim() : '' }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 720], 400, '{ status: "rejected", errors: $json.validation.errors }');

  pg(w, 'Load Contact', [col(4), 200],
    `SELECT c.contact_id, c.name, c.email, c.phone, c.company, c.history, COALESCE(s.status, 'none') AS state_status, COALESCE(s.step, 0) AS step
FROM revival_contacts c LEFT JOIN revival_state s ON s.contact_id = c.contact_id WHERE c.contact_id = $1`,
    '[$json.request.contact_id]', { alwaysOutputData: true });
  w.add('Contact Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Validate Request').item.json;
const r = $input.item.json;
return { json: { ...s, contact: r.contact_id ? { contact_id: r.contact_id, name: r.name, email: r.email, phone: r.phone, company: r.company, history: r.history, state_status: r.state_status, step: r.step } : null } };`))
   .add('Contact Found?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ !!$json.contact }}'));
  respond(w, 'Respond 404', [col(7), 560], 404, '{ status: "unknown_contact", contact_id: $json.request.contact_id }');

  idempotency(w, {
    workflow: WF, position: [col(7), 100], paramCount: 2, params: '$json.request.contact_id, $json.request.message', stateFrom: 'Contact Result', check: 'New reply?',
    keySql: "'revival-reply:' || $1 || ':' || md5($2)",
  });
  respond(w, 'Accepted 202', [col(10), 0], 202, '{ status: "accepted", contact_id: $json.request.contact_id }');
  respond(w, 'Duplicate 200', [col(10), 280], 200, '{ status: "duplicate", contact_id: $json.request.contact_id }');

  // ── Bajas: determinístico, ANTES de cualquier IA ──
  w.add('Opt-out Check', 'n8n-nodes-base.code', 2, [col(11), 0], code(embed(
    [{ file: 'revival', exports: ['detectOptOut'] }],
    `const s = $input.item.json;
return { json: { ...s, optout: detectOptOut(s.request.message) } };`)),
    { notes: 'COMPLIANCE primero: una frase de baja suprime al contacto SIN pasar por la IA, y la IA no puede deshacerlo.' })
   .add('Opt-out?', 'n8n-nodes-base.if', 2.2, [col(12), 0], ifBool('={{ $json.optout.optOut }}'))
   .add('Outcome · Opt-out', 'n8n-nodes-base.code', 2, [col(13), -240], code(outcome('opted_out',
    "state_status: 'opted_out', classification: 'unsubscribe', suppress: true, outbound_text: '', cf: { revival_stage: 'opted_out', revival_opt_out_at: now }")));

  // ── Clasificación (IA o mock) ──
  w.add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(13), 140], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Classify Request', 'n8n-nodes-base.code', 2, [col(14), 40], code(embed(
    [{ file: 'revival', exports: ['buildClassifyRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClassifyRequest(s.request.message, s.contact, s.config.model) } };`)))
   .add('Mock Classify', 'n8n-nodes-base.code', 2, [col(14), 260], code(embed(
    [{ file: 'revival', exports: ['mockClassify'] }],
    `const s = $input.item.json;
return { json: { ...s, classification: mockClassify(s.request.message) } };`)),
    { notes: 'Sustituto local de Claude (aiMode=mock): palabras clave.' });

  const classifyExit = httpWithBackoff(w, {
    name: 'Claude Classify', position: [col(15), 40], source: 'Build Classify Request', workflow: WF, entity: '$json.request.contact_id',
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
  w.add('Parse Classification', 'n8n-nodes-base.code', 2, [col(18), 40], code(embed(
    [{ file: 'revival', exports: ['parseClassification'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, classification: parseClassification(http_response) } };`)),
    { notes: 'Si la IA falla (tras los reintentos), la clasificación queda ok:false → ruta de revisión humana. Nunca se envía nada sin clasificar.' })
   .add('Route Reply', 'n8n-nodes-base.code', 2, [col(19), 140], code(embed(
    [{ file: 'revival', exports: ['routeReply'] }],
    `const s = $input.item.json;
const c = s.classification.ok ? s.classification : { label: 'unclear', confidence: 0 };
const route = s.classification.ok ? routeReply(c, s.config) : { action: 'review', reason: 'classification_failed' };
return { json: { ...s, route } };`)),
    { notes: 'DETERMINÍSTICO: la etiqueta de la IA solo se traduce a una acción con reglas fijas. Una baja detectada por la IA también suprime.' })
   .add('Suppress?', 'n8n-nodes-base.if', 2.2, [col(20), 140], ifEquals('={{ $json.route.action }}', 'suppress'))
   .add('Outcome · Suppress', 'n8n-nodes-base.code', 2, [col(21), -240], code(outcome('opted_out',
    "state_status: 'opted_out', classification: 'unsubscribe', suppress: true, outbound_text: '', cf: { revival_stage: 'opted_out', revival_opt_out_at: now }")))
   .add('Close?', 'n8n-nodes-base.if', 2.2, [col(21), 260], ifEquals('={{ $json.route.action }}', 'close'))
   .add('Outcome · Close', 'n8n-nodes-base.code', 2, [col(22), 120], code(outcome('not_interested',
    "state_status: 'not_interested', classification: s.classification.label, suppress: false, outbound_text: '', cf: { revival_stage: 'not_interested' }")))
   .add('Review?', 'n8n-nodes-base.if', 2.2, [col(22), 400], ifEquals('={{ $json.route.action }}', 'review'))
   .add('Outcome · Review', 'n8n-nodes-base.code', 2, [col(23), 300], code(outcome('needs_review',
    "state_status: 'needs_review', classification: s.classification.ok ? s.classification.label : 'unclear', suppress: false, outbound_text: '', cf: { revival_stage: 'needs_review' }")))
   .add('Notify Review', 'n8n-nodes-base.emailSend', 2.1, [col(24), 300], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Reply needs a human: ' + $json.contact.name + ' (' + $json.route.reason + ')' }}",
    emailFormat: 'text',
    text: "={{ 'Contact: ' + $json.contact.name + ' <' + $json.contact.email + '>\\nWhy: ' + $json.route.reason + '\\nClassification: ' + ($json.classification.ok ? $json.classification.label + ' (' + $json.classification.confidence + ')' : 'FAILED: ' + $json.classification.error) + '\\n\\nReply:\\n' + $json.request.message + '\\n\\nNo message was sent. The sequence is paused (needs_review).' }}",
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput' })
   .add('Capture Review Email', 'n8n-nodes-base.code', 2, [col(25), 300], code(
    `const s = $('Outcome · Review').item.json;
const r = $input.item.json;
return { json: { ...s, outcome: { ...s.outcome, result: r.error ? 'review_notify_failed' : 'needs_review', notify_error: r.error ? JSON.stringify(r.error) : null } } };`));

  // ── Interés / agendar: el DUEÑO aprueba antes de enviar el link de booking ──
  w.add('Build Booking Request', 'n8n-nodes-base.code', 2, [col(23), 560], code(embed(
    [{ file: 'revival', exports: ['bookingMessage', 'isSpanish'] }],
    `const s = $input.item.json;
const lang = isSpanish(s.request.message) ? 'es' : 'en';
const draft = bookingMessage(s.contact, s.config.bookingUrl, lang);
const notes = Array.isArray(s.contact.history) ? s.contact.history : [];
const last = notes.length ? String(notes[notes.length - 1].text || '') : 'n/a';
const lines = [
  'REPLY from ' + s.contact.name + ' <' + s.contact.email + '>:',
  s.request.message,
  '',
  'CLASSIFICATION: ' + s.classification.label + ' (confidence ' + s.classification.confidence + ', ' + s.classification.model + ')',
  'WHY: ' + s.classification.rationale,
  'LAST CRM NOTE: ' + last,
  '',
  'MESSAGE TO SEND IF YOU APPROVE (the booking link is added by code, not by the AI):',
  draft,
];
${ESC}
return { json: { ...s, booking: { draft, lang }, booking_message: lines.map(esc).join("\\n") } };`)),
    { notes: 'El link de booking sale de la config, nunca de la IA.' })
   .add('Request Booking Approval', 'n8n-nodes-base.emailSend', 2.1, [col(24), 560], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Interested lead: approve booking link to ' + $json.contact.name }}",
    message: '={{ $json.booking_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Send booking link', disapproveLabel: 'Do not send' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Aprobación humana antes de enviar el link. Canal: email (Mailpit). Para Slack, cambiar este nodo por Slack → Send and Wait.' })
   .add('Apply Booking Decision', 'n8n-nodes-base.code', 2, [col(25), 560], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Booking Request').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, booking: { ...state.booking, decision: h.status, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: sin respuesta o ambigua = NO se envía.' })
   .add('Booking Approved?', 'n8n-nodes-base.if', 2.2, [col(26), 560], ifEquals('={{ $json.booking.decision }}', 'approved_by_human'))
   .add('Outcome · Booking Declined', 'n8n-nodes-base.code', 2, [col(27), 820], code(outcome('booking_declined',
    "state_status: 'needs_review', classification: s.classification.label, suppress: false, outbound_text: '', cf: { revival_stage: s.booking.decision === 'no_human_response' ? 'booking_no_response' : 'booking_declined' }")));

  w.add('Send Mode?', 'n8n-nodes-base.if', 2.2, [col(27), 560], ifEquals('={{ $json.config.crmMode }}', 'live'))
   .add('Send Booking (mock email)', 'n8n-nodes-base.emailSend', 2.1, [col(28), 700], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.contact.email }}',
    subject: 'Let us find a time',
    emailFormat: 'text',
    text: '={{ $json.booking.draft }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA simulada (Mailpit). Solo tras aprobación del dueño.' })
   .add('Capture Mock Send', 'n8n-nodes-base.code', 2, [col(29), 700], code(
    `const s = $('Send Mode?').item.json;
const r = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'mock', error: JSON.stringify(r.error) } : { ok: true, mode: 'mock' } } };`));

  const sendExit = httpWithBackoff(w, {
    name: 'GHL Send Booking', position: [col(28), 440], source: 'Send Mode?', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint/cuerpo SIN verificar contra la API real.',
    params: {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/conversations/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-04-15' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ type: 'SMS', contactId: $json.contact.contact_id, message: $json.booking.draft }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Live Send', 'n8n-nodes-base.code', 2, [col(31), 440], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'live', error: JSON.stringify(r.error) } : { ok: true, mode: 'live', response: r } } };`))
   .add('Booking Sent OK?', 'n8n-nodes-base.if', 2.2, [col(32), 600], ifBool('={{ $json.send.ok }}'))
   .add('Outcome · Booking Sent', 'n8n-nodes-base.code', 2, [col(33), 520], code(outcome('booking_sent',
    "state_status: 'booking_sent', classification: s.classification.label, suppress: false, outbound_text: s.booking.draft, cf: { revival_stage: 'booking_link_sent', revival_booking_link_sent_at: now }")))
   .add('Outcome · Booking Send Failed', 'n8n-nodes-base.code', 2, [col(33), 700], code(outcome('booking_send_failed',
    "state_status: 'needs_review', classification: s.classification.label, suppress: false, outbound_text: '', send_error: s.send.error, cf: { revival_stage: 'booking_send_failed' }")));

  // ── Persistencia atómica (inbound + outbound + estado + bajas + custom fields) ──
  w.add('Persist Outcome', 'n8n-nodes-base.postgres', 2.6, [col(34), 200], {
    operation: 'executeQuery',
    query: `WITH inb AS (
  INSERT INTO revival_messages (contact_id, direction, channel, body, status, classification, execution_id)
  VALUES ($1, 'in', 'email', $2, 'received', NULLIF($3, ''), $4) RETURNING id
), outb AS (
  INSERT INTO revival_messages (contact_id, direction, touch, channel, body, status, execution_id)
  SELECT $1, 'out', NULL, 'email', $5, 'booking_sent', $4 WHERE NULLIF($5, '') IS NOT NULL RETURNING id
), st AS (
  INSERT INTO revival_state (contact_id, status, step, last_classification, updated_at)
  VALUES ($1, $6, COALESCE((SELECT step FROM revival_state WHERE contact_id = $1), 0), NULLIF($3, ''), now())
  ON CONFLICT (contact_id) DO UPDATE SET status = EXCLUDED.status, last_classification = EXCLUDED.last_classification, next_touch_at = NULL, updated_at = now()
  RETURNING contact_id
), sup AS (
  INSERT INTO suppression_list (key, reason, contact_id, source)
  SELECT k, 'unsubscribe', $1, 'reply:' || $4 FROM unnest(ARRAY[lower($7), norm_phone($8, '57')]) AS k
  WHERE $9::boolean AND k IS NOT NULL AND k <> ''
  ON CONFLICT (key) DO NOTHING RETURNING key
), cf AS (
  INSERT INTO revival_custom_fields (contact_id, field, value)
  SELECT $1, f.key, f.value FROM jsonb_each_text($10::jsonb) f(key, value)
  ON CONFLICT (contact_id, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING field
)
SELECT $11::jsonb AS state, (SELECT count(*) FROM st) AS state_rows, (SELECT count(*) FROM inb) AS inbound_rows, (SELECT count(*) FROM sup) AS suppression_rows`,
    options: { queryReplacement: "={{ [$json.request.contact_id, $json.request.message, $json.outcome.classification, $execution.id, $json.outcome.outbound_text, $json.outcome.state_status, $json.contact.email ?? '', $json.contact.phone ?? '', String($json.outcome.suppress), JSON.stringify($json.outcome.cf), JSON.stringify($json)] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
       notes: 'UNA sentencia: respuesta entrante, mensaje saliente, estado, baja (si aplica) y custom fields. El estado completo viaja en la columna "state" para restaurarlo.' })
   .add('Outcome Persisted', 'n8n-nodes-base.code', 2, [col(35), 200], code(
    `const r = $input.item.json;
const s = r.state;
if (Number(r.state_rows) !== 1 || Number(r.inbound_rows) !== 1) throw new Error('Persist outcome wrote unexpected rows for ' + s.request.contact_id + ': ' + JSON.stringify({ state_rows: r.state_rows, inbound_rows: r.inbound_rows }));
return { json: { ...s, persisted: { ok: true, suppression_rows: Number(r.suppression_rows) } } };`))
   .add('CF Mode?', 'n8n-nodes-base.if', 2.2, [col(36), 200], ifEquals('={{ $json.config.crmMode }}', 'live'));

  const cfExit = httpWithBackoff(w, {
    name: 'GHL Custom Fields', position: [col(37), 60], source: 'CF Mode?', workflow: WF, entity: '$json.request.contact_id',
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
      jsonBody: "={{ JSON.stringify({ customFields: Object.entries($json.outcome.cf).map(([key, v]) => ({ key: key, field_value: v })) }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Custom Fields', 'n8n-nodes-base.code', 2, [col(40), 60], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, cf: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(41), 200], code(
    `const s = $input.item.json;
const status = s.cf && !s.cf.ok ? 'custom_fields_failed' : s.outcome.result;
return { json: { ...s, result: { status, contact_id: s.request.contact_id, state: s.outcome.state_status } } };`),
    { notes: 'Todas las rutas terminan aquí.' });
  markIdempotency(w, {
    position: [col(42), 40], keyExpr: '$json.idem.key',
    statusExpr: "['booking_send_failed', 'custom_fields_failed', 'review_notify_failed'].includes($json.result.status) ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status })',
  });
  w.add('Assert Reply', 'n8n-nodes-base.code', 2, [col(42), 200], code(
    `const s = $input.item.json;
const r = s.result;
if (r.status === 'booking_send_failed') throw new Error('Booking link to ' + r.contact_id + ' was approved but sending failed: ' + s.outcome.send_error + '. Contact set to needs_review.');
if (r.status === 'review_notify_failed') throw new Error('Reply from ' + r.contact_id + ' needs review but the owner notification failed: ' + s.outcome.notify_error);
if (r.status === 'custom_fields_failed') throw new Error('Reply from ' + r.contact_id + ' processed (' + s.outcome.state_status + ') but updating GHL custom fields failed: ' + s.cf.error);
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de persistir y registrar → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.request.contact_id', ...o });
  L('Validate Request', { step: 'reply_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'reply_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Opt-out Check', { step: 'optout_check', detail: '({ opt_out: $json.optout.optOut, matched: $json.optout.matched })' });
  L('Mock Classify', { step: 'classified', name: 'Log · classified (mock)', detail: '({ label: $json.classification.label, confidence: $json.classification.confidence, model: "mock" })' });
  L('Parse Classification', { step: 'classified', name: 'Log · classified (live)', status: "$json.classification.ok ? 'ok' : 'failed'", error: "$json.classification.error ?? ''", detail: '({ label: $json.classification.label ?? null, confidence: $json.classification.confidence ?? null, attempts: $json.http.attempt })' });
  L('Route Reply', { step: 'routed', detail: '({ action: $json.route.action, reason: $json.route.reason })' });
  L('Build Booking Request', { step: 'booking_approval_requested', status: "'waiting'", detail: '({ lang: $json.booking.lang })' });
  L('Apply Booking Decision', { step: 'booking_decision', status: "$json.booking.decision === 'no_human_response' ? 'failed' : 'ok'", error: "$json.booking.decision === 'no_human_response' ? 'no response: booking link NOT sent' : ''", detail: '({ result: $json.booking.decision })' });
  L('Capture Mock Send', { step: 'booking_sent', name: 'Log · booking_sent (mock)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''" });
  L('Capture Live Send', { step: 'booking_sent', name: 'Log · booking_sent (live)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ attempts: $json.http.attempt })' });
  L('Outcome Persisted', { step: 'state_updated', detail: '({ state: $json.outcome.state_status, classification: $json.outcome.classification, suppressed: $json.persisted.suppression_rows, fields: $json.outcome.cf })' });
  L('Capture Custom Fields', { step: 'ghl_custom_fields', status: "$json.cf.ok ? 'ok' : 'failed'", error: "$json.cf.error ?? ''" });
  L('Build Result', { step: 'completed', status: "['booking_send_failed', 'custom_fields_failed', 'review_notify_failed'].includes($json.result.status) ? 'failed' : 'ok'", error: "['booking_send_failed', 'custom_fields_failed', 'review_notify_failed'].includes($json.result.status) ? $json.result.status : ''", detail: '({ result: $json.result })' });

  w.note('## Revival · Handle Reply\nBajas determinísticas primero (sin IA) → clasificación → enrutado con reglas fijas → interés: el dueño aprueba antes de enviar el link de booking → persistencia atómica.', [col(0) - 20, -380], col(14), 130)
   .note('### Log por paso → Postgres\nNodos "Log · …": ramas laterales.', [col(0) - 20, 860], 400, 90);

  // ── Conexiones ──
  w.link('Reply Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load Contact', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load Contact', 'Contact Result').link('Contact Result', 'Contact Found?')
   .link('Contact Found?', 'Claim Idempotency', 0).link('Contact Found?', 'Respond 404', 1)
   .link('New reply?', 'Accepted 202', 0).link('New reply?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Opt-out Check').link('Opt-out Check', 'Opt-out?')
   .link('Opt-out?', 'Outcome · Opt-out', 0).link('Opt-out?', 'AI Mode?', 1)
   .link('AI Mode?', 'Build Classify Request', 0).link('AI Mode?', 'Mock Classify', 1)
   .link('Build Classify Request', 'Claude Classify').link(classifyExit, 'Parse Classification', 1)
   .link('Parse Classification', 'Route Reply').link('Mock Classify', 'Route Reply')
   .link('Route Reply', 'Suppress?')
   .link('Suppress?', 'Outcome · Suppress', 0).link('Suppress?', 'Close?', 1)
   .link('Close?', 'Outcome · Close', 0).link('Close?', 'Review?', 1)
   .link('Review?', 'Outcome · Review', 0).link('Review?', 'Build Booking Request', 1)
   .link('Outcome · Review', 'Notify Review').link('Notify Review', 'Capture Review Email')
   .link('Build Booking Request', 'Request Booking Approval').link('Request Booking Approval', 'Apply Booking Decision')
   .link('Apply Booking Decision', 'Booking Approved?')
   .link('Booking Approved?', 'Send Mode?', 0).link('Booking Approved?', 'Outcome · Booking Declined', 1)
   .link('Send Mode?', 'GHL Send Booking', 0).link('Send Mode?', 'Send Booking (mock email)', 1)
   .link('Send Booking (mock email)', 'Capture Mock Send').link(sendExit, 'Capture Live Send', 1)
   .link('Capture Mock Send', 'Booking Sent OK?').link('Capture Live Send', 'Booking Sent OK?')
   .link('Booking Sent OK?', 'Outcome · Booking Sent', 0).link('Booking Sent OK?', 'Outcome · Booking Send Failed', 1);
  for (const from of ['Outcome · Opt-out', 'Outcome · Suppress', 'Outcome · Close', 'Capture Review Email', 'Outcome · Booking Declined', 'Outcome · Booking Sent', 'Outcome · Booking Send Failed']) w.link(from, 'Persist Outcome');
  w.link('Persist Outcome', 'Outcome Persisted').link('Outcome Persisted', 'CF Mode?')
   .link('CF Mode?', 'GHL Custom Fields', 0).link('CF Mode?', 'Build Result', 1)
   .link(cfExit, 'Capture Custom Fields', 1).link('Capture Custom Fields', 'Build Result')
   .link('Build Result', 'Mark Idempotency').link('Build Result', 'Assert Reply');

  return { file: 'revival-reply.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
