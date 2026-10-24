const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { QUALIFIER } = require('./qualifier-config');

const WF = 'qualifier-inbound';
const col = n => n * 240;

const ACQUIRE_LOCK = `WITH up AS (
  INSERT INTO conversation_state (contact_id, name, phone, email, timezone, last_inbound_at, locked_until)
  VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), now(), now() + interval '90 seconds')
  ON CONFLICT (contact_id) DO UPDATE SET
    locked_until = now() + interval '90 seconds', last_inbound_at = now(), updated_at = now(),
    name = COALESCE(NULLIF($2, ''), conversation_state.name), phone = COALESCE(NULLIF($3, ''), conversation_state.phone),
    email = COALESCE(NULLIF($4, ''), conversation_state.email), timezone = COALESCE(NULLIF($5, ''), conversation_state.timezone)
  WHERE conversation_state.locked_until IS NULL OR conversation_state.locked_until < now()
  RETURNING *
)
SELECT up.*,
  EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(up.email) OR x.key = norm_phone(up.phone, '57')) AS suppressed,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('direction', h.direction, 'body', h.body) ORDER BY h.id)
            FROM (SELECT id, direction, body FROM messages_log WHERE contact_id = $1 AND message_id <> $6 ORDER BY id DESC LIMIT 8) h), '[]'::jsonb) AS history
FROM up`;
const IN = "$('Check Opt-out').item.json.inbound";   // el nodo anterior es una consulta SQL: su salida ya no trae el estado
const LOCK_PARAMS = `[${IN}.contact_id, ${IN}.name, ${IN}.phone, ${IN}.email, ${IN}.timezone, ${IN}.message_id]`;

module.exports = function qualifierInbound() {
  const w = Workflow('qualifierinbound1', 'Qualifier · Inbound Message (Auditable)');

  // ── Entrada + validación ──
  w.add('Inbound Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'qualifier-inbound', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Mensaje entrante del lead (en GHL: workflow action "Inbound Message" → webhook). Protegido por x-qualifier-token. La forma REAL del webhook de GHL no está verificada.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: QUALIFIER }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Inbound', 'n8n-nodes-base.code', 2, [col(2), 300], code(embed(
    [{ file: 'qualifier', exports: ['normalizeInbound'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeInbound(item.body);
const errors = [...n.errors];
if (!item.headers || item.headers['x-qualifier-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { inbound: n.message, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: acepta el formato plano y variantes de GHL; rechaza sin token, sin ids o con cuerpo vacío o gigante.' })
   .add('Valid Message?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 700], 400, '{ status: "rejected", errors: $json.validation.errors }');

  idempotency(w, {
    workflow: WF, position: [col(4), 200], paramCount: 1, params: '$json.inbound.message_id', stateFrom: 'Normalize Inbound', check: 'New message?',
    keySql: "'qualifier-in:' || $1",
  });
  respond(w, 'Duplicate 200', [col(7), 520], 200, '{ status: "duplicate", message_id: $json.inbound.message_id }');
  respond(w, 'Accepted 202', [col(7), 200], 202, '{ status: "accepted", message_id: $json.inbound.message_id, contact_id: $json.inbound.contact_id }');

  // ── Opt-out ANTES de cualquier IA: determinístico, la IA no puede deshacerlo ──
  w.add('Check Opt-out', 'n8n-nodes-base.code', 2, [col(8), 200], code(embed(
    [{ file: 'revival', exports: ['detectOptOut'] }],
    `const s = $input.item.json;
return { json: { ...s, optout: detectOptOut(s.inbound.body) } };`)),
    { notes: 'STOP / baja / unsubscribe / "no me escriban"… Se evalúa antes de la IA: una baja nunca depende de que el modelo la entienda.' })
   .add('Opt-out?', 'n8n-nodes-base.if', 2.2, [col(9), 200], ifBool('={{ $json.optout.optOut }}'));

  pg(w, 'Persist Opt-out', [col(10), 1100],
    `WITH st AS (
  INSERT INTO conversation_state (contact_id, status, name, phone, email, timezone, last_inbound_at)
  VALUES ($1, 'dnc', NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), now())
  ON CONFLICT (contact_id) DO UPDATE SET status = 'dnc', locked_until = NULL, last_inbound_at = now(), updated_at = now() RETURNING contact_id
), sup AS (
  INSERT INTO suppression_list (key, reason, contact_id, source)
  SELECT k, 'unsubscribe', $1, 'qualifier:' || $6 FROM unnest(ARRAY[lower(NULLIF($4, '')), norm_phone(NULLIF($3, ''), '57')]) AS k WHERE k IS NOT NULL
  ON CONFLICT (key) DO NOTHING RETURNING key
), m AS (
  INSERT INTO messages_log (message_id, contact_id, direction, body, execution_id) VALUES ($6, $1, 'in', $7, $8) ON CONFLICT (message_id) DO NOTHING RETURNING id
), cf AS (
  INSERT INTO revival_custom_fields (contact_id, field, value) VALUES ($1, 'qualifier_stage', 'dnc')
  ON CONFLICT (contact_id, field) DO UPDATE SET value = 'dnc', updated_at = now() RETURNING field
), ob AS (
  UPDATE qualifier_outbox SET status = 'blocked', reason = 'opt_out' WHERE contact_id = $1 AND status = 'pending' RETURNING id
), rs AS (
  UPDATE revival_state SET status = 'opted_out', updated_at = now() WHERE contact_id = $1 AND status <> 'opted_out' RETURNING contact_id
)
SELECT (SELECT count(*) FROM st) AS state_rows, (SELECT count(*) FROM sup) AS suppression_rows, (SELECT count(*) FROM ob) AS cancelled_messages, (SELECT count(*) FROM rs) AS revival_stopped`,
    '[$json.inbound.contact_id, $json.inbound.name, $json.inbound.phone, $json.inbound.email, $json.inbound.timezone, $json.inbound.message_id, $json.inbound.body, $execution.id]',
    { notes: 'En UNA sentencia: estado dnc, lista de bajas (email y teléfono), mensaje, campo mirror de GHL, cancela mensajes pendientes y frena el Revival de ese contacto.' });
  w.add('Opt-out Persisted', 'n8n-nodes-base.code', 2, [col(11), 1100], code(
    `const s = $('Opt-out?').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1) throw new Error('Opt-out for ' + s.inbound.contact_id + ' wrote unexpected rows: ' + JSON.stringify(r));
return { json: { ...s, optout_result: r } };`))
   .add('Tag Mode?', 'n8n-nodes-base.if', 2.2, [col(12), 1100], ifEquals('={{ $json.config.crmMode }}', 'live'));
  const tagExit = httpWithBackoff(w, {
    name: 'GHL Tag DNC', position: [col(13), 1000], source: 'Tag Mode?', workflow: WF, entity: '$json.inbound.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint de tags SIN verificar contra la API real. En modo mock el mirror vive en revival_custom_fields.',
    params: {
      method: 'POST',
      url: "={{ 'https://services.leadconnectorhq.com/contacts/' + $json.inbound.contact_id + '/tags' }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ tags: ['dnc'] }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Tag', 'n8n-nodes-base.code', 2, [col(16), 1000], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, tag: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`))
   .add('Opt-out Done', 'n8n-nodes-base.code', 2, [col(17), 1100], code(
    `const s = $input.item.json;
const errors = s.tag && !s.tag.ok ? ['dnc_tag_failed: ' + s.tag.error] : [];
return { json: { ...s, outcome: 'opt_out', holds_lock: false, errors } };`),
    { notes: 'La baja YA está guardada localmente (no depende de GHL). Si el tag en GHL falla, se avisa.' });

  // ── Mensaje a la conversación + bloqueo por contacto (dos mensajes seguidos nunca se procesan a la vez) ──
  pg(w, 'Log Inbound', [col(10), 100],
    "INSERT INTO messages_log (message_id, contact_id, direction, body, execution_id) VALUES ($1, $2, 'in', $3, $4) ON CONFLICT (message_id) DO NOTHING RETURNING id",
    '[$json.inbound.message_id, $json.inbound.contact_id, $json.inbound.body, $execution.id]',
    { alwaysOutputData: true, notes: 'El mensaje se guarda ANTES de intentar el bloqueo: si algo falla después, el mensaje del lead nunca se pierde.' });
  pg(w, 'Acquire Lock', [col(11), 100], ACQUIRE_LOCK, LOCK_PARAMS,
    { alwaysOutputData: true, notes: 'Crea/actualiza la conversación y toma el bloqueo de 90 s SOLO si está libre (atómico). Sin fila de vuelta = otro mensaje del mismo lead está en proceso.' });
  w.add('Lock Result', 'n8n-nodes-base.code', 2, [col(12), 100], code(
    `const s = $('Check Opt-out').item.json;
const row = $input.item.json.contact_id ? $input.item.json : null;
return { json: { ...s, lock: { acquired: row !== null }, convo: row } };`))
   .add('Locked?', 'n8n-nodes-base.if', 2.2, [col(13), 100], ifBool('={{ $json.lock.acquired }}'))
   .add('Wait For Lock', 'n8n-nodes-base.wait', 1.1, [col(14), 400],
    { resume: 'timeInterval', amount: 8, unit: 'seconds' }, { webhookId: uid(), notes: 'Otro mensaje del mismo lead se está procesando: espera 8 s y reintenta UNA vez.' });
  pg(w, 'Acquire Lock (retry)', [col(15), 400], ACQUIRE_LOCK, LOCK_PARAMS, { alwaysOutputData: true });
  w.add('Lock Result (retry)', 'n8n-nodes-base.code', 2, [col(16), 400], code(
    `const s = $('Check Opt-out').item.json;
const row = $input.item.json.contact_id ? $input.item.json : null;
return { json: { ...s, lock: { acquired: row !== null, retried: true }, convo: row } };`))
   .add('Locked? (retry)', 'n8n-nodes-base.if', 2.2, [col(17), 400], ifBool('={{ $json.lock.acquired }}'))
   .add('Lock Failed', 'n8n-nodes-base.code', 2, [col(18), 620], code(
    `const s = $input.item.json;
return { json: { ...s, outcome: 'lock_failed', holds_lock: false, errors: ['lock_not_acquired: another message from this lead was still being processed after 8 s. The inbound message is saved in messages_log; reprocess it.'] } };`),
    { notes: 'No se descarta en silencio: el mensaje queda guardado y el fallo dispara el Error Handler.' });

  // ── Ruta según el estado de la conversación ──
  w.add('Route State', 'n8n-nodes-base.code', 2, [col(19), 100], code(
    `const s = $input.item.json;
const c = s.convo;
let route = 'decide';
let reason = null;
if (c.suppressed || c.status === 'dnc') { route = 'ignore'; reason = 'suppressed'; }
else if (['handoff', 'booked', 'disqualified'].includes(c.status)) { route = 'ignore'; reason = 'conversation_' + c.status; }
else if (c.step === 'booking' && c.status !== 'stale') route = 'booking';
return { json: { ...s, route, route_reason: reason } };`),
    { notes: 'DETERMINÍSTICO. Dnc/handoff/agendada/descalificada: el bot no responde (el mensaje queda en el log). Stale que responde: se reactiva.' })
   .add('Ignore?', 'n8n-nodes-base.if', 2.2, [col(20), 100], ifEquals('={{ $json.route }}', 'ignore'))
   .add('Ignored', 'n8n-nodes-base.code', 2, [col(21), 780], code(
    `const s = $input.item.json;
return { json: { ...s, outcome: 'ignored:' + s.route_reason, holds_lock: true, errors: [] } };`))
   .add('Booking Step?', 'n8n-nodes-base.if', 2.2, [col(21), 100], ifEquals('={{ $json.route }}', 'booking'))
   .add('Call Booking (choose)', 'n8n-nodes-base.httpRequest', 4.2, [col(22), 600], {
    method: 'POST',
    url: '={{ $json.config.bookingUrl }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-qualifier-token', value: '={{ $json.config.internalToken }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ contact_id: $json.inbound.contact_id, mode: 'choose', message_id: $json.inbound.message_id, body: $json.inbound.body }) }}",
    options: { timeout: 150000, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', notes: 'El lead respondió a los horarios ofrecidos: Booking interpreta la elección. SÍNCRONO: este flujo mantiene el bloqueo hasta que Booking termina.' })
   .add('Capture Booking (choose)', 'n8n-nodes-base.code', 2, [col(23), 600], code(
    `const s = $('Booking Step?').item.json;
const r = $input.item.json;
const ok = r.statusCode === 200;
return { json: { ...s, outcome: 'booking:' + (ok && r.body ? r.body.status : 'error'), holds_lock: true, booking: { ok, status: r.statusCode, body: r.body }, errors: ok ? [] : ['booking_call_failed: ' + (r.error ? JSON.stringify(r.error).slice(0, 200) : 'status ' + r.statusCode)] } };`));

  // ── Decisión: la IA juzga, el código decide ──
  w.add('Build Context', 'n8n-nodes-base.code', 2, [col(22), 100], code(embed(
    [{ file: 'qualifier', exports: ['isSpanish'] }],
    `const s = $input.item.json;
const c = s.convo;
const ctx = {
  lang: isSpanish([...(c.history || []).filter(m => m.direction === 'in').map(m => m.body), s.inbound.body].join(' ')) ? 'es' : 'en',
  answers: c.answers || [],
  attempts: c.attempts || 0,
  history: c.history || [],
  pending_criterion: c.pending_criterion || null,
  reactivated: c.status === 'stale',
};
return { json: { ...s, ctx } };`)))
   .add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(23), 100], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Decision Request', 'n8n-nodes-base.code', 2, [col(24), 0], code(embed(
    [{ file: 'qualifier', exports: ['buildDecisionRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildDecisionRequest({ criteria: s.config.criteria, answers: s.ctx.answers, history: s.ctx.history, body: s.inbound.body, businessName: s.config.businessName, model: s.config.model }) } };`),
    ), { notes: 'El mensaje y el historial del lead viajan dentro de <lead_data>: son DATOS, nunca instrucciones.' })
   .add('Mock Decision', 'n8n-nodes-base.code', 2, [col(24), 240], code(embed(
    [{ file: 'qualifier', exports: ['mockDecide'] }],
    `const s = $input.item.json;
return { json: { ...s, ai: mockDecide({ criteria: s.config.criteria, answers: s.ctx.answers, body: s.inbound.body, pendingCriterion: s.ctx.pending_criterion }) } };`)),
    { notes: 'Sustituto local de Claude (aiMode=mock): determinístico. Ganchos de prueba: [[mock:invalid]] y [[mock:ai_down]] simulan fallos del modelo.' });

  const claudeExit = httpWithBackoff(w, {
    name: 'Claude Decision', position: [col(25), 0], source: 'Build Decision Request', workflow: WF, entity: '$json.inbound.contact_id',
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
  w.add('Parse Decision', 'n8n-nodes-base.code', 2, [col(28), 0], code(embed(
    [{ file: 'qualifier', exports: ['parseDecision'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, ai: parseDecision(http_response, { body: state.inbound.body, criteria: state.config.criteria }) } };`)),
    { notes: 'Valida el JSON: enums, rango de confianza y que cada respuesta extraída cite TEXTUALMENTE el mensaje del lead.' })
   .add('Decide Next', 'n8n-nodes-base.code', 2, [col(29), 100], code(embed(
    [{ file: 'qualifier', exports: ['decideNext'] }],
    `const s = $input.item.json;
const next = decideNext(s.ai.ok ? { decision: s.ai.decision } : { decision: null, error: s.ai.error },
  { answers: s.ctx.answers, attempts: s.ctx.attempts },
  { criteria: s.config.criteria, confidenceThreshold: s.config.confidenceThreshold, maxAttempts: s.config.maxAttempts }, s.ctx.lang);
const statusByAction = { ask: 'active', qualify: 'qualified', disqualify: 'disqualified', handoff: 'handoff' };
const kind = next.action === 'ask' ? 'question' : next.action === 'disqualify' ? 'close' : '';
return { json: { ...s, next: { ...next, status: statusByAction[next.action], outbox_kind: kind } } };`)),
    { notes: 'DETERMINÍSTICO: confianza < umbral, intentos máximos, "quiere un humano", mensaje con link/precio/largo o JSON inválido → handoff. "Calificó" lo decide el código (todos los criterios requeridos respondidos), no el modelo.' });

  pg(w, 'Persist Decision', [col(30), 100],
    `WITH st AS (
  UPDATE conversation_state SET status = $2, answers = $3::jsonb, attempts = $4::int, pending_criterion = NULLIF($5, ''),
    handoff_reason = CASE WHEN $2 = 'handoff' THEN NULLIF($6, '') ELSE NULL END, disqualify_reason = CASE WHEN $2 = 'disqualified' THEN NULLIF($6, '') ELSE NULL END, updated_at = now()
  WHERE contact_id = $1 RETURNING contact_id
), m AS (
  UPDATE messages_log SET llm_output = $7::jsonb WHERE message_id = $8 RETURNING id
), ob AS (
  INSERT INTO qualifier_outbox (contact_id, kind, body, execution_id) SELECT $1, $9, $10, $11 WHERE $10 <> '' RETURNING id
)
SELECT (SELECT count(*) FROM st) AS state_rows, (SELECT id FROM ob) AS outbox_id`,
    "[$json.inbound.contact_id, $json.next.status, JSON.stringify($json.next.answers), String($json.next.attempts), $json.next.criterion || '', $json.next.reason || '', JSON.stringify({ ai: $json.ai, next: { action: $json.next.action, reason: $json.next.reason } }), $json.inbound.message_id, $json.next.outbox_kind, $json.next.message || '', $execution.id]",
    { notes: 'Estado, respuestas acumuladas, salida del modelo y mensaje en la cola de salida en UNA sentencia. El mensaje NO se envía aquí: pasa por Send Message (guarda + horario).' });
  w.add('Decision Persisted', 'n8n-nodes-base.code', 2, [col(31), 100], code(
    `const s = $('Decide Next').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1) throw new Error('Persist decision wrote unexpected rows for ' + s.inbound.contact_id + ': ' + JSON.stringify(r));
return { json: { ...s, outbox_id: r.outbox_id ? Number(r.outbox_id) : null } };`))
   .add('Has Message?', 'n8n-nodes-base.if', 2.2, [col(32), 100], ifBool('={{ $json.outbox_id !== null }}'))
   .add('Dispatch Send', 'n8n-nodes-base.httpRequest', 4.2, [col(33), 0], {
    method: 'POST',
    url: '={{ $json.config.sendUrl }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-qualifier-token', value: '={{ $json.config.internalToken }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ outbox_id: $json.outbox_id }) }}',
    options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', notes: 'Send Message vuelve a comprobar TODO (bajas, horario local) antes de enviar; fuera de horario deja el mensaje en cola.' })
   .add('Capture Dispatch', 'n8n-nodes-base.code', 2, [col(34), 0], code(
    `const s = $('Has Message?').item.json;
const r = $input.item.json;
const ok = [200, 202, 409].includes(r.statusCode);
return { json: { ...s, dispatch: { ok, status: r.statusCode, body: r.body, error: ok ? '' : (r.error ? JSON.stringify(r.error).slice(0, 200) : 'status ' + r.statusCode) } } };`))
   .add('Qualified?', 'n8n-nodes-base.if', 2.2, [col(35), 100], ifEquals('={{ $json.next.action }}', 'qualify'))
   .add('Call Booking (offer)', 'n8n-nodes-base.httpRequest', 4.2, [col(36), 0], {
    method: 'POST',
    url: '={{ $json.config.bookingUrl }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-qualifier-token', value: '={{ $json.config.internalToken }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ contact_id: $json.inbound.contact_id, mode: 'offer', message_id: $json.inbound.message_id }) }}",
    options: { timeout: 150000, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', notes: 'Calificó: Booking consulta horarios libres y ofrece 2-3. SÍNCRONO.' })
   .add('Capture Booking (offer)', 'n8n-nodes-base.code', 2, [col(37), 0], code(
    `const s = $('Qualified?').item.json;
const r = $input.item.json;
const ok = r.statusCode === 200;
return { json: { ...s, booking: { ok, status: r.statusCode, body: r.body, error: ok ? '' : (r.error ? JSON.stringify(r.error).slice(0, 200) : 'status ' + r.statusCode) } } };`))
   .add('Handoff?', 'n8n-nodes-base.if', 2.2, [col(38), 100], ifEquals('={{ $json.next.action }}', 'handoff'))
   .add('Build Handoff Email', 'n8n-nodes-base.code', 2, [col(39), 0], code(embed(
    [{ file: 'qualifier', exports: ['buildHandoffEmail'] }],
    `const s = $input.item.json;
const email = buildHandoffEmail({ contact: { contact_id: s.inbound.contact_id, name: s.convo.name || s.inbound.name, phone: s.convo.phone, email: s.convo.email }, reason: s.next.reason, answers: s.next.answers, history: s.ctx.history, latest: s.inbound.body, businessName: s.config.businessName });
return { json: { ...s, handoff_email: email } };`)))
   .add('Send Handoff Email', 'n8n-nodes-base.emailSend', 2.1, [col(40), 0], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.handoffEmail }}',
    subject: '={{ $json.handoff_email.subject }}',
    emailFormat: 'text',
    text: '={{ $json.handoff_email.text }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Escala a un humano con el resumen y el motivo. El bot deja de responder a este contacto.' })
   .add('Capture Handoff', 'n8n-nodes-base.code', 2, [col(41), 0], code(
    `const s = $('Build Handoff Email').item.json;
const r = $input.item.json;
return { json: { ...s, handoff_sent: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Prepare Finish', 'n8n-nodes-base.code', 2, [col(42), 300], code(
    `const s = $input.item.json;
const errors = [...(s.errors || [])];
let outcome = s.outcome;
let holds = s.holds_lock;
if (!outcome) {
  outcome = 'decided:' + s.next.action + (s.next.reason ? ':' + s.next.reason : '');
  holds = true;
  if (s.dispatch && !s.dispatch.ok) errors.push('send_dispatch_failed: ' + s.dispatch.error + ' (the message stays in the outbox)');
  if (s.booking && !s.booking.ok) errors.push('booking_call_failed: ' + s.booking.error);
  if (s.handoff_sent && !s.handoff_sent.ok) errors.push('handoff_email_failed: ' + s.handoff_sent.error);
}
return { json: { ...s, result: { outcome, errors, holds_lock: holds === true, message_id: s.inbound.message_id, contact_id: s.inbound.contact_id } } };`),
    { notes: 'Todas las rutas terminan aquí: opt-out, ignorado, fallo de bloqueo, booking o decisión.' });
  pg(w, 'Release Lock', [col(43), 300],
    'UPDATE conversation_state SET locked_until = NULL, updated_at = now() WHERE contact_id = $1 AND $2::boolean RETURNING contact_id',
    '[$json.result.contact_id, String($json.result.holds_lock)]', { alwaysOutputData: true, notes: 'Solo libera el bloqueo si ESTA ejecución lo tomó.' });
  w.add('Finish Run', 'n8n-nodes-base.code', 2, [col(44), 300], code(`return { json: { ...$('Prepare Finish').item.json } };`));
  markIdempotency(w, {
    position: [col(45), 140], keyExpr: '$json.idem.key',
    statusExpr: "$json.result.errors.length > 0 ? 'failed' : 'done'",
    resultExpr: '({ outcome: $json.result.outcome, errors: $json.result.errors })',
  });
  w.add('Assert Inbound', 'n8n-nodes-base.code', 2, [col(45), 300], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Inbound message ' + r.message_id + ' (' + r.contact_id + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar estado y log → Error Handler. La clave queda "failed": reprocesar el mensaje es posible.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.inbound.contact_id', ...o });
  L('Normalize Inbound', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ message_id: $json.inbound.message_id })' });
  L('Idempotency Result', { step: 'message_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Check Opt-out', { step: 'optout_checked', status: "$json.optout.optOut ? 'skipped' : 'ok'", error: "$json.optout.optOut ? 'opt_out' : ''", detail: '({ matched: $json.optout.matched })' });
  L('Opt-out Persisted', { step: 'opted_out', detail: '({ result: $json.optout_result })' });
  L('Lock Result', { step: 'lock_attempt', status: "$json.lock.acquired ? 'ok' : 'waiting'" });
  L('Lock Result (retry)', { step: 'lock_retry', status: "$json.lock.acquired ? 'ok' : 'failed'", error: "$json.lock.acquired ? '' : 'lock_not_acquired'" });
  L('Route State', { step: 'state_routed', detail: '({ route: $json.route, reason: $json.route_reason, status: $json.convo.status, step: $json.convo.step })' });
  L('Decide Next', { step: 'decided', status: "$json.next.action === 'handoff' ? 'skipped' : 'ok'", error: "$json.next.action === 'handoff' ? $json.next.reason : ''", detail: '({ action: $json.next.action, reason: $json.next.reason, attempts: $json.next.attempts, ai_ok: $json.ai.ok, intent: $json.ai.ok ? $json.ai.decision.intent : null, confidence: $json.ai.ok ? $json.ai.decision.confidence : null, answered: $json.next.answers.map(a => a.criterion) })' });
  L('Capture Dispatch', { step: 'send_dispatched', status: "$json.dispatch.ok ? 'ok' : 'failed'", error: "$json.dispatch.error", detail: '({ outbox_id: $json.outbox_id, status: $json.dispatch.status })' });
  L('Capture Booking (offer)', { step: 'booking_offer_requested', name: 'Log · booking_offer_requested', status: "$json.booking.ok ? 'ok' : 'failed'", error: "$json.booking.error", detail: '({ status: $json.booking.status })' });
  L('Capture Booking (choose)', { step: 'booking_choice_requested', name: 'Log · booking_choice_requested', status: "$json.booking.ok ? 'ok' : 'failed'", error: "$json.errors.join(' | ')", detail: '({ status: $json.booking.status })' });
  L('Capture Handoff', { step: 'handoff_notified', status: "$json.handoff_sent.ok ? 'ok' : 'failed'", error: "$json.handoff_sent.error ?? ''", detail: '({ reason: $json.next.reason })' });
  L('Finish Run', { step: 'completed', status: "$json.result.errors.length > 0 ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ outcome: $json.result.outcome })' });

  w.note('## Qualifier · Inbound Message\nIdempotency by message_id → opt-out check BEFORE any AI → per-contact lock → Claude judges (extracts answers with verbatim evidence, proposes next question) → deterministic gate decides: ask / qualify / disqualify / human handoff.', [col(0) - 20, -330], col(12), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches.', [col(0) - 20, 1400], 480, 90);

  // ── Conexiones ──
  w.link('Inbound Webhook', 'Config').link('Config', 'Normalize Inbound').link('Normalize Inbound', 'Valid Message?')
   .link('Valid Message?', 'Claim Idempotency', 0).link('Valid Message?', 'Respond 400', 1)
   .link('New message?', 'Accepted 202', 0).link('New message?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Check Opt-out').link('Check Opt-out', 'Opt-out?')
   .link('Opt-out?', 'Persist Opt-out', 0).link('Opt-out?', 'Log Inbound', 1)
   .link('Persist Opt-out', 'Opt-out Persisted').link('Opt-out Persisted', 'Tag Mode?')
   .link('Tag Mode?', 'GHL Tag DNC', 0).link('Tag Mode?', 'Opt-out Done', 1)
   .link(tagExit, 'Capture Tag', 1).link('Capture Tag', 'Opt-out Done').link('Opt-out Done', 'Prepare Finish')
   .link('Log Inbound', 'Acquire Lock').link('Acquire Lock', 'Lock Result').link('Lock Result', 'Locked?')
   .link('Locked?', 'Route State', 0).link('Locked?', 'Wait For Lock', 1)
   .link('Wait For Lock', 'Acquire Lock (retry)').link('Acquire Lock (retry)', 'Lock Result (retry)').link('Lock Result (retry)', 'Locked? (retry)')
   .link('Locked? (retry)', 'Route State', 0).link('Locked? (retry)', 'Lock Failed', 1).link('Lock Failed', 'Prepare Finish')
   .link('Route State', 'Ignore?')
   .link('Ignore?', 'Ignored', 0).link('Ignore?', 'Booking Step?', 1).link('Ignored', 'Prepare Finish')
   .link('Booking Step?', 'Call Booking (choose)', 0).link('Booking Step?', 'Build Context', 1)
   .link('Call Booking (choose)', 'Capture Booking (choose)').link('Capture Booking (choose)', 'Prepare Finish')
   .link('Build Context', 'AI Mode?').link('AI Mode?', 'Build Decision Request', 0).link('AI Mode?', 'Mock Decision', 1)
   .link('Build Decision Request', 'Claude Decision').link(claudeExit, 'Parse Decision', 1)
   .link('Parse Decision', 'Decide Next').link('Mock Decision', 'Decide Next')
   .link('Decide Next', 'Persist Decision').link('Persist Decision', 'Decision Persisted').link('Decision Persisted', 'Has Message?')
   .link('Has Message?', 'Dispatch Send', 0).link('Has Message?', 'Qualified?', 1)
   .link('Dispatch Send', 'Capture Dispatch').link('Capture Dispatch', 'Qualified?')
   .link('Qualified?', 'Call Booking (offer)', 0).link('Qualified?', 'Handoff?', 1)
   .link('Call Booking (offer)', 'Capture Booking (offer)').link('Capture Booking (offer)', 'Handoff?')
   .link('Handoff?', 'Build Handoff Email', 0).link('Handoff?', 'Prepare Finish', 1)
   .link('Build Handoff Email', 'Send Handoff Email').link('Send Handoff Email', 'Capture Handoff').link('Capture Handoff', 'Prepare Finish')
   .link('Prepare Finish', 'Release Lock').link('Release Lock', 'Finish Run')
   .link('Finish Run', 'Mark Idempotency').link('Finish Run', 'Assert Inbound');

  return { file: 'qualifier-inbound.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
