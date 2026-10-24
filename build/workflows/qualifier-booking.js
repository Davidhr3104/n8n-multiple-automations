const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond } = require('../foundation');
const { QUALIFIER } = require('./qualifier-config');

const WF = 'qualifier-booking';
const col = n => n * 240;

const dispatchSend = (name, position) => ({
  name, position,
  params: {
    method: 'POST',
    url: '={{ $json.config.sendUrl }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-qualifier-token', value: '={{ $json.config.internalToken }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ outbox_id: $json.outbox_id }) }}',
    options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true } } },
  },
});

module.exports = function qualifierBooking() {
  const w = Workflow('qualifierbooking1', 'Qualifier · Booking (Auditable)');

  // ── Entrada + validación ──
  w.add('Booking Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 400],
    { httpMethod: 'POST', path: 'qualifier-booking', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Lo llama Qualifier · Inbound: mode=offer (el lead calificó) o mode=choose (el lead respondió a los horarios). Síncrono. Protegido por x-qualifier-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 400],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: QUALIFIER }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Request', 'n8n-nodes-base.code', 2, [col(2), 400], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-qualifier-token'] !== c.internalToken) errors.push('bad_token');
if (typeof b.contact_id !== 'string' || !b.contact_id) errors.push('contact_id');
if (!['offer', 'choose'].includes(b.mode)) errors.push('mode');
if (typeof b.message_id !== 'string' || !b.message_id) errors.push('message_id');
return { json: { request: { contact_id: b.contact_id, mode: b.mode, message_id: b.message_id }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 400], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 900], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Guarda: solo se ofrece a quien calificó y solo se interpreta una elección si hay horarios ofrecidos ──
  pg(w, 'Load State', [col(4), 400],
    `SELECT s.*, (SELECT body FROM messages_log WHERE message_id = $2) AS latest_body,
  EXISTS (SELECT 1 FROM suppression_list x WHERE x.key = lower(s.email) OR x.key = norm_phone(s.phone, '57')) AS suppressed,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('direction', h.direction, 'body', h.body) ORDER BY h.id)
            FROM (SELECT id, direction, body FROM messages_log WHERE contact_id = $1 AND message_id <> $2 ORDER BY id DESC LIMIT 8) h), '[]'::jsonb) AS history
FROM conversation_state s WHERE s.contact_id = $1`,
    '[$json.request.contact_id, $json.request.message_id]', { alwaysOutputData: true });
  w.add('Guard Result', 'n8n-nodes-base.code', 2, [col(5), 400], code(embed(
    [{ file: 'qualifier', exports: ['isSpanish'] }, { file: 'schedule', exports: ['inferTimezone'] }],
    `const s = $('Validate Request').item.json;
const row = $input.item.json.contact_id ? $input.item.json : null;
let reason = null;
if (!row) reason = 'no_conversation';
else if (row.suppressed || row.status === 'dnc') reason = 'suppressed';
else if (s.request.mode === 'offer' && !(row.status === 'qualified' && row.step === 'qualifying')) reason = 'not_ready_to_offer';
else if (s.request.mode === 'choose' && !(row.step === 'booking' && Array.isArray(row.offered_slots) && row.offered_slots.length > 0)) reason = 'no_slots_offered';
const tzinfo = row ? inferTimezone({ timezone: row.timezone, phone: row.phone }, s.config) : null;
const convo = row ? { ...row, history: row.history || [], answers: row.answers || [] } : null;
const leadText = row ? [...(row.history || []).filter(m => m.direction === 'in').map(m => m.body), row.latest_body || ''].join(' ') : '';
const lang = isSpanish(leadText) ? 'es' : 'en';
return { json: { ...s, convo, tzinfo, lang, guard: { ok: reason === null, reason } } };`)),
    { notes: 'DETERMINÍSTICO. offer: solo si la conversación está calificada y aún no se ofrecieron horarios. choose: solo si hay horarios ofrecidos.' })
   .add('Can Proceed?', 'n8n-nodes-base.if', 2.2, [col(6), 400], ifBool('={{ $json.guard.ok }}'));
  respond(w, 'Respond 409 (blocked)', [col(7), 900], 409, '{ status: "blocked", reason: $json.guard.reason, contact_id: $json.request.contact_id }');
  w.add('Mode?', 'n8n-nodes-base.if', 2.2, [col(7), 400], ifEquals('={{ $json.request.mode }}', 'choose'));

  // ══════════ CHOOSE: interpretar qué horario eligió el lead ══════════
  w.add('Choice AI Mode?', 'n8n-nodes-base.if', 2.2, [col(8), 140], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Choice Request', 'n8n-nodes-base.code', 2, [col(9), 20], code(embed(
    [{ file: 'qualifier', exports: ['buildSlotChoiceRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildSlotChoiceRequest({ body: s.convo.latest_body, offered: s.convo.offered_slots, tz: s.tzinfo.tz, model: s.config.model }) } };`)))
   .add('Mock Choice', 'n8n-nodes-base.code', 2, [col(9), 260], code(embed(
    [{ file: 'qualifier', exports: ['mockSlotChoice'] }],
    `const s = $input.item.json;
return { json: { ...s, choice: mockSlotChoice(s.convo.latest_body, s.convo.offered_slots) } };`)),
    { notes: 'Sustituto local de Claude: número, "primero/segundo/tercero". [[mock:ai_down]] simula la caída del modelo.' });

  const choiceExit = httpWithBackoff(w, {
    name: 'Claude Slot Choice', position: [col(10), 20], source: 'Build Choice Request', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API".',
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
  w.add('Parse Choice', 'n8n-nodes-base.code', 2, [col(13), 20], code(embed(
    [{ file: 'qualifier', exports: ['parseSlotChoice'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, choice: parseSlotChoice(http_response, state.convo.offered_slots) } };`)),
    { notes: 'La IA devuelve un slot_id; el código solo lo acepta si es UNO de los ofrecidos (y con confianza suficiente). Cualquier otra cosa = ninguno.' })
   .add('Route Choice', 'n8n-nodes-base.code', 2, [col(14), 140], code(
    `const s = $input.item.json;
const c = s.choice;
const used = s.convo.booking_attempts || 0;
const max = s.config.maxBookingAttempts;
let action; let reason = null; let slot = null;
if (!c.ok) { action = 'handoff'; reason = 'choice_ai_failed: ' + c.error; }
else if (c.slot_id !== 'none') { action = 'book'; slot = s.convo.offered_slots.find(o => o.slot_id === c.slot_id); if (!slot) { action = 'handoff'; reason = 'chosen_slot_not_offered'; } }
else if (used >= max) { action = 'handoff'; reason = 'slot_choice_unclear_after_' + used + '_offers'; }
else { action = 'reoffer'; reason = c.valid === false ? 'invalid_slot_id' : 'choice_unclear'; }
return { json: { ...s, route: { action, reason, slot } } };`),
    { notes: 'DETERMINÍSTICO: elección válida → agendar; poco clara → reofrecer (máx. 2 veces); IA caída → humano.' })
   .add('Book?', 'n8n-nodes-base.if', 2.2, [col(15), 140], ifEquals('={{ $json.route.action }}', 'book'))
   .add('Reoffer?', 'n8n-nodes-base.if', 2.2, [col(16), 400], ifEquals('={{ $json.route.action }}', 'reoffer'));

  // ── Crear la cita: mock (Postgres, el índice único decide la carrera) o live (GHL) ──
  w.add('Appointment Mode?', 'n8n-nodes-base.if', 2.2, [col(16), 20], ifEquals('={{ $json.config.crmMode }}', 'live'));
  pg(w, 'Create Appointment (mock)', [col(17), 160],
    `INSERT INTO bookings (contact_id, appointment_id, slot_start)
SELECT $1, 'mock-' || replace(gen_random_uuid()::text, '-', ''), $2::timestamptz
WHERE NOT EXISTS (SELECT 1 FROM mock_calendar_busy WHERE slot_start = $2::timestamptz)
ON CONFLICT (slot_start) DO NOTHING
RETURNING id, appointment_id`,
    '[$json.request.contact_id, $json.route.slot.start]', { alwaysOutputData: true, notes: 'Calendario simulado: el índice único bookings(slot_start) resuelve la carrera si dos leads eligen el mismo horario. Sin fila = ocupado.' });
  w.add('Capture Mock Appointment', 'n8n-nodes-base.code', 2, [col(18), 160], code(
    `const s = $('Appointment Mode?').item.json;
const r = $input.item.json;
return { json: { ...s, appointment: r.appointment_id ? { ok: true, conflict: false, mode: 'mock', appointment_id: r.appointment_id } : { ok: false, conflict: true, mode: 'mock', error: 'slot_taken' } } };`));
  const apptExit = httpWithBackoff(w, {
    name: 'GHL Create Appointment', position: [col(17), -60], source: 'Appointment Mode?', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint/cuerpo de calendars/events/appointments y el código de conflicto (409/422) SIN verificar contra la API real.',
    params: {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/calendars/events/appointments',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-04-15' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ calendarId: $json.config.ghlCalendarId, locationId: $json.config.ghlLocationId, contactId: $json.request.contact_id, startTime: $json.route.slot.start, title: 'Discovery call' }) }}",
      options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true } } },
    },
  });
  w.add('Capture Live Appointment', 'n8n-nodes-base.code', 2, [col(20), -60], code(
    `const { http_response: r, ...s } = $input.item.json;
const status = r && r.statusCode;
const body = r && r.body ? r.body : r;
const ok = status ? status >= 200 && status < 300 : !(r && r.error);
const conflict = status === 409 || status === 422;
return { json: { ...s, appointment: ok ? { ok: true, conflict: false, mode: 'live', appointment_id: String((body && (body.id || body.appointmentId)) || 'unknown') } : { ok: false, conflict, mode: 'live', error: conflict ? 'slot_taken' : 'create_appointment_failed: ' + JSON.stringify(r && (r.error || r.body)).slice(0, 200) } } };`));
  w.add('Appointment Result', 'n8n-nodes-base.if', 2.2, [col(21), 140], ifBool('={{ $json.appointment.ok }}'))
   .add('Conflict?', 'n8n-nodes-base.if', 2.2, [col(22), 300], ifBool('={{ $json.appointment.conflict }}'))
   .add('Route Conflict', 'n8n-nodes-base.code', 2, [col(23), 300], code(
    `const s = $input.item.json;
const used = s.convo.booking_attempts || 0;
const exhausted = used >= s.config.maxBookingAttempts;
return { json: { ...s, route: exhausted ? { action: 'handoff', reason: 'slot_conflict_after_' + used + '_offers' } : { action: 'reoffer', reason: 'slot_taken' } } };`),
    { notes: 'El horario elegido ya estaba ocupado: se reofrecen horarios frescos (máx. 2 veces) y luego un humano.' })
   .add('Conflict Reoffer?', 'n8n-nodes-base.if', 2.2, [col(24), 300], ifEquals('={{ $json.route.action }}', 'reoffer'))
   .add('Appointment Failed', 'n8n-nodes-base.code', 2, [col(23), 520], code(
    `const s = $input.item.json;
return { json: { ...s, route: { action: 'handoff', reason: s.appointment.error } } };`),
    { notes: 'Fallo real de la API (no un conflicto): se escala a un humano; el lead no queda sin respuesta.' });

  // ── Agendada: asignación round-robin, estado, confirmación y aviso al rep ──
  w.add('Assign Rep', 'n8n-nodes-base.postgres', 2.6, [col(22), 40], {
    operation: 'executeQuery',
    query: "SELECT ((nextval('rep_rr_seq') - 1) % GREATEST($1::int, 1))::int AS idx",
    options: { queryReplacement: '={{ [($json.config.salesReps || []).length] }}' },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, notes: 'Round-robin atómico (misma secuencia que Lead Intake).' })
   .add('Rep Result', 'n8n-nodes-base.code', 2, [col(23), 40], code(embed(
    [{ file: 'qualifier', exports: ['confirmMessage'] }],
    `const s = $('Appointment Result').item.json;
const idx = Number($input.item.json.idx);
const reps = s.config.salesReps || [];
const rep = reps.length ? reps[idx % reps.length] : null;
const confirmation = confirmMessage(s.route.slot.start, s.tzinfo.tz, s.lang);
return { json: { ...s, rep, confirmation } };`)));
  pg(w, 'Persist Booking', [col(24), 40],
    `WITH bk AS (
  UPDATE bookings SET rep = $3 WHERE appointment_id = $2 AND contact_id = $1 RETURNING id
), st AS (
  UPDATE conversation_state SET status = 'booked', offered_slots = NULL, pending_criterion = NULL, updated_at = now() WHERE contact_id = $1 RETURNING contact_id
), cf AS (
  INSERT INTO revival_custom_fields (contact_id, field, value) VALUES ($1, 'qualifier_stage', 'booked'), ($1, 'opportunity_stage', 'Booked')
  ON CONFLICT (contact_id, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING field
), ob AS (
  INSERT INTO qualifier_outbox (contact_id, kind, body, execution_id) VALUES ($1, 'confirmation', $4, $5) RETURNING id
)
SELECT (SELECT count(*) FROM bk) AS booking_rows, (SELECT count(*) FROM st) AS state_rows, (SELECT id FROM ob) AS outbox_id`,
    "[$json.request.contact_id, $json.appointment.appointment_id, $json.rep ? $json.rep.name : '', $json.confirmation, $execution.id]",
    { notes: 'Rep, estado "booked", etapa de oportunidad (mirror de GHL) y confirmación en la cola de salida: UNA sentencia.' });
  w.add('Booking Persisted', 'n8n-nodes-base.code', 2, [col(25), 40], code(
    `const s = $('Rep Result').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1) throw new Error('Persist booking wrote unexpected rows for ' + s.request.contact_id + ': ' + JSON.stringify(r));
return { json: { ...s, outbox_id: Number(r.outbox_id), booked: { start: s.route.slot.start, appointment_id: s.appointment.appointment_id, rep: s.rep ? s.rep.name : null } } };`));
  const dBooked = dispatchSend('Dispatch Confirmation', [col(26), 40]);
  w.add(dBooked.name, 'n8n-nodes-base.httpRequest', 4.2, dBooked.position, dBooked.params,
    { onError: 'continueRegularOutput', notes: 'La confirmación es transaccional: sale aunque ya pasara el horario laboral (Send Message lo permite solo para este tipo).' })
   .add('Capture Confirmation', 'n8n-nodes-base.code', 2, [col(27), 40], code(
    `const s = $('Booking Persisted').item.json;
const r = $input.item.json;
const ok = [200, 202, 409].includes(r.statusCode);
return { json: { ...s, dispatch: { ok, status: r.statusCode, error: ok ? '' : (r.error ? JSON.stringify(r.error).slice(0, 200) : 'status ' + r.statusCode) } } };`))
   .add('Build Rep Email', 'n8n-nodes-base.code', 2, [col(28), 40], code(
    `const s = $input.item.json;
const answers = s.convo.answers.map(a => '- ' + a.criterion + ': ' + a.value).join('\\n') || '- (none)';
const text = ['A call was booked for ' + (s.convo.name || s.request.contact_id) + ' (' + (s.convo.phone || s.convo.email || 'no contact data') + ').', 'When: ' + s.route.slot.start + ' (UTC) — lead time zone: ' + s.tzinfo.tz, 'Appointment: ' + s.appointment.appointment_id, '', 'Qualification answers:', answers].join('\\n');
return { json: { ...s, rep_email: { to: s.rep ? s.rep.email : s.config.handoffEmail, subject: 'New booked call: ' + (s.convo.name || s.request.contact_id), text } } };`))
   .add('Notify Rep', 'n8n-nodes-base.emailSend', 2.1, [col(29), 40], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.rep_email.to }}',
    subject: '={{ $json.rep_email.subject }}',
    emailFormat: 'text',
    text: '={{ $json.rep_email.text }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Avisa al vendedor asignado (round-robin).' })
   .add('Capture Rep Notice', 'n8n-nodes-base.code', 2, [col(30), 40], code(
    `const s = $('Build Rep Email').item.json;
const r = $input.item.json;
return { json: { ...s, rep_notice: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true }, result: { status: 'booked', contact_id: s.request.contact_id, start: s.route.slot.start, rep: s.rep ? s.rep.name : null } } };`));

  // ══════════ OFFER: horarios libres → ofrecer 2-3 ══════════
  w.add('Slots Mode?', 'n8n-nodes-base.if', 2.2, [col(25), 640], ifEquals('={{ $json.config.crmMode }}', 'live'));
  pg(w, 'Load Busy Slots', [col(26), 780],
    'SELECT COALESCE(jsonb_agg(slot_start), \'[]\'::jsonb) AS busy FROM (SELECT slot_start FROM mock_calendar_busy UNION SELECT slot_start FROM bookings) b',
    null, { notes: 'Calendario simulado: ocupados + ya agendados.' });
  w.add('Mock Slots', 'n8n-nodes-base.code', 2, [col(27), 780], code(embed(
    [{ file: 'qualifier', exports: ['mockFreeSlots'] }],
    `const s = $('Slots Mode?').item.json;
const busy = $input.item.json.busy || [];
return { json: { ...s, free: { ok: true, mode: 'mock', slots: mockFreeSlots(new Date().toISOString(), busy) } } };`)));
  const slotsExit = httpWithBackoff(w, {
    name: 'GHL Free Slots', position: [col(26), 560], source: 'Slots Mode?', workflow: WF, entity: '$json.request.contact_id',
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel. Endpoint de free-slots y forma de la respuesta SIN verificar; si no se reconoce, se escala a un humano.',
    params: {
      method: 'GET',
      url: "={{ 'https://services.leadconnectorhq.com/calendars/' + $json.config.ghlCalendarId + '/free-slots?startDate=' + Date.now() + '&endDate=' + (Date.now() + 7 * 24 * 3600 * 1000) }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-04-15' }, { name: 'Accept', value: 'application/json' }] },
      options: { timeout: 30000 },
    },
  });
  w.add('Parse Live Slots', 'n8n-nodes-base.code', 2, [col(29), 560], code(embed(
    [{ file: 'qualifier', exports: ['parseGhlSlots'] }],
    `const { http_response: r, ...s } = $input.item.json;
const slots = parseGhlSlots(r);
return { json: { ...s, free: slots ? { ok: true, mode: 'live', slots } : { ok: false, mode: 'live', slots: [], error: 'free_slots_unrecognized: ' + JSON.stringify(r).slice(0, 200) } } };`)))
   .add('Build Offer', 'n8n-nodes-base.code', 2, [col(30), 640], code(embed(
    [{ file: 'qualifier', exports: ['pickOffers', 'offerMessage'] }],
    `const s = $input.item.json;
const offers = s.free.ok ? pickOffers(s.free.slots, 3) : [];
const attempt = s.request.mode === 'choose' ? (s.convo.booking_attempts || 0) + 1 : 0;
return { json: { ...s, offer: { offers, attempt, text: offers.length ? offerMessage(offers, s.tzinfo.tz, s.lang) : '' }, route: offers.length ? { action: 'offer', reason: s.request.mode === 'choose' ? 'reoffer' : 'first_offer' } : { action: 'handoff', reason: s.free.ok ? 'no_free_slots' : s.free.error } } };`)),
    { notes: 'Ofrece hasta 3 horarios repartidos en días distintos, en la zona horaria del lead. El texto lo arma el código, no la IA.' })
   .add('Has Offers?', 'n8n-nodes-base.if', 2.2, [col(31), 640], ifEquals('={{ $json.route.action }}', 'offer'));
  pg(w, 'Persist Offer', [col(32), 560],
    `WITH st AS (
  UPDATE conversation_state SET step = 'booking', status = 'qualified', offered_slots = $2::jsonb, booking_attempts = $3::int, updated_at = now() WHERE contact_id = $1 RETURNING contact_id
), ob AS (
  INSERT INTO qualifier_outbox (contact_id, kind, body, execution_id) VALUES ($1, 'booking_offer', $4, $5) RETURNING id
)
SELECT (SELECT count(*) FROM st) AS state_rows, (SELECT id FROM ob) AS outbox_id`,
    '[$json.request.contact_id, JSON.stringify($json.offer.offers), String($json.offer.attempt), $json.offer.text, $execution.id]',
    { notes: 'Guarda qué horarios se ofrecieron (la elección se valida contra esta lista) y encola el mensaje.' });
  w.add('Offer Persisted', 'n8n-nodes-base.code', 2, [col(33), 560], code(
    `const s = $('Has Offers?').item.json;
const r = $input.item.json;
if (Number(r.state_rows) !== 1) throw new Error('Persist offer wrote unexpected rows for ' + s.request.contact_id + ': ' + JSON.stringify(r));
return { json: { ...s, outbox_id: Number(r.outbox_id) } };`));
  const dOffer = dispatchSend('Dispatch Offer', [col(34), 560]);
  w.add(dOffer.name, 'n8n-nodes-base.httpRequest', 4.2, dOffer.position, dOffer.params,
    { onError: 'continueRegularOutput', notes: 'Send Message comprueba bajas y horario local antes de enviar; fuera de horario el ofrecimiento queda en cola.' })
   .add('Capture Offer Dispatch', 'n8n-nodes-base.code', 2, [col(35), 560], code(
    `const s = $('Offer Persisted').item.json;
const r = $input.item.json;
const ok = [200, 202, 409].includes(r.statusCode);
return { json: { ...s, dispatch: { ok, status: r.statusCode, error: ok ? '' : (r.error ? JSON.stringify(r.error).slice(0, 200) : 'status ' + r.statusCode) }, result: { status: 'offered', contact_id: s.request.contact_id, attempt: s.offer.attempt, slots: s.offer.offers.length } } };`));

  // ══════════ HANDOFF ══════════
  w.add('Handoff Entry', 'n8n-nodes-base.code', 2, [col(30), 1000], code(
    `const s = $input.item.json;
return { json: { ...s, handoff_reason: s.route.reason } };`),
    { notes: 'Todos los caminos que no pueden continuar solos llegan aquí: IA caída, elección poco clara, sin horarios, conflicto repetido, fallo de la API.' });
  pg(w, 'Persist Handoff', [col(31), 1000],
    "UPDATE conversation_state SET status = 'handoff', handoff_reason = $2, updated_at = now() WHERE contact_id = $1 RETURNING contact_id",
    '[$json.request.contact_id, String($json.handoff_reason).slice(0, 300)]');
  w.add('Build Handoff Email', 'n8n-nodes-base.code', 2, [col(32), 1000], code(embed(
    [{ file: 'qualifier', exports: ['buildHandoffEmail'] }],
    `const s = $('Handoff Entry').item.json;
const email = buildHandoffEmail({ contact: { contact_id: s.request.contact_id, name: s.convo.name, phone: s.convo.phone, email: s.convo.email }, reason: s.handoff_reason, answers: s.convo.answers, history: s.convo.history, latest: s.convo.latest_body, businessName: s.config.businessName });
return { json: { ...s, handoff_email: email } };`)))
   .add('Send Handoff Email', 'n8n-nodes-base.emailSend', 2.1, [col(33), 1000], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.handoffEmail }}',
    subject: '={{ $json.handoff_email.subject }}',
    emailFormat: 'text',
    text: '={{ $json.handoff_email.text }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Escala a un humano con el resumen y el motivo. El bot deja de responder a este contacto.' })
   .add('Capture Handoff', 'n8n-nodes-base.code', 2, [col(34), 1000], code(
    `const s = $('Build Handoff Email').item.json;
const r = $input.item.json;
return { json: { ...s, handoff_sent: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true }, result: { status: 'handoff', contact_id: s.request.contact_id, reason: s.handoff_reason } } };`));

  // ── Cierre común ──
  w.add('Build Result', 'n8n-nodes-base.code', 2, [col(36), 400], code(
    `const s = $input.item.json;
const errors = [];
if (s.dispatch && !s.dispatch.ok) errors.push('send_dispatch_failed: ' + s.dispatch.error + ' (the message stays in the outbox)');
if (s.rep_notice && !s.rep_notice.ok) errors.push('rep_notice_failed: ' + s.rep_notice.error);
if (s.handoff_sent && !s.handoff_sent.ok) errors.push('handoff_email_failed: ' + s.handoff_sent.error);
return { json: { ...s, result: { ...s.result, errors } } };`),
    { notes: 'Todas las rutas terminan aquí: agendada, horarios ofrecidos o escalada a humano.' });
  respond(w, 'Respond Result', [col(37), 400], 200, '{ status: $json.result.status, contact_id: $json.result.contact_id, reason: $json.result.reason ?? null }');
  w.add('Assert Booking', 'n8n-nodes-base.code', 2, [col(37), 640], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Booking for ' + r.contact_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar estado y log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.request.contact_id', ...o });
  L('Validate Request', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ mode: $json.request.mode })' });
  L('Guard Result', { step: 'guard_checked', status: "$json.guard.ok ? 'ok' : 'skipped'", error: "$json.guard.ok ? '' : $json.guard.reason", detail: '({ mode: $json.request.mode, tz: $json.tzinfo ? $json.tzinfo.tz : null, tz_source: $json.tzinfo ? $json.tzinfo.source : null })' });
  L('Route Choice', { step: 'choice_interpreted', status: "$json.route.action === 'handoff' ? 'skipped' : 'ok'", error: "$json.route.action === 'handoff' ? $json.route.reason : ''", detail: '({ action: $json.route.action, reason: $json.route.reason, claimed: $json.choice.claimed ?? null, confidence: $json.choice.confidence ?? null })' });
  L('Capture Mock Appointment', { step: 'appointment_attempted', name: 'Log · appointment_attempted (mock)', status: "$json.appointment.ok ? 'ok' : 'skipped'", error: "$json.appointment.error ?? ''", detail: '({ slot: $json.route.slot.start, mode: "mock" })' });
  L('Capture Live Appointment', { step: 'appointment_attempted', name: 'Log · appointment_attempted (live)', status: "$json.appointment.ok ? 'ok' : 'failed'", error: "$json.appointment.error ?? ''", detail: '({ slot: $json.route.slot.start, mode: "live" })' });
  L('Booking Persisted', { step: 'booked', detail: '({ booked: $json.booked })' });
  L('Capture Rep Notice', { step: 'rep_notified', status: "$json.rep_notice.ok ? 'ok' : 'failed'", error: "$json.rep_notice.error ?? ''", detail: '({ rep: $json.rep ? $json.rep.name : null })' });
  L('Build Offer', { step: 'slots_offered', status: "$json.route.action === 'offer' ? 'ok' : 'skipped'", error: "$json.route.action === 'offer' ? '' : $json.route.reason", detail: '({ offers: $json.offer.offers.length, attempt: $json.offer.attempt, free: $json.free.slots.length, mode: $json.free.mode })' });
  L('Capture Handoff', { step: 'handoff_notified', status: "$json.handoff_sent.ok ? 'ok' : 'failed'", error: "$json.handoff_sent.error ?? ''", detail: '({ reason: $json.handoff_reason })' });
  L('Build Result', { step: 'completed', status: "$json.result.errors.length > 0 ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## Qualifier · Booking\nOffer: free calendar slots → 2-3 options in the lead\'s time zone. Choose: the AI maps the reply to an OFFERED slot id (validated in code) → create appointment (a double booking is impossible) → confirm + notify the assigned rep. Anything that cannot continue goes to a human.', [col(0) - 20, -330], col(14), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches.', [col(0) - 20, 1280], 480, 90);

  // ── Conexiones ──
  w.link('Booking Webhook', 'Config').link('Config', 'Validate Request').link('Validate Request', 'Valid Request?')
   .link('Valid Request?', 'Load State', 0).link('Valid Request?', 'Respond 400', 1)
   .link('Load State', 'Guard Result').link('Guard Result', 'Can Proceed?')
   .link('Can Proceed?', 'Mode?', 0).link('Can Proceed?', 'Respond 409 (blocked)', 1)
   .link('Mode?', 'Choice AI Mode?', 0).link('Mode?', 'Slots Mode?', 1)
   .link('Choice AI Mode?', 'Build Choice Request', 0).link('Choice AI Mode?', 'Mock Choice', 1)
   .link('Build Choice Request', 'Claude Slot Choice').link(choiceExit, 'Parse Choice', 1)
   .link('Parse Choice', 'Route Choice').link('Mock Choice', 'Route Choice').link('Route Choice', 'Book?')
   .link('Book?', 'Appointment Mode?', 0).link('Book?', 'Reoffer?', 1)
   .link('Reoffer?', 'Slots Mode?', 0).link('Reoffer?', 'Handoff Entry', 1)
   .link('Appointment Mode?', 'GHL Create Appointment', 0).link('Appointment Mode?', 'Create Appointment (mock)', 1)
   .link('Create Appointment (mock)', 'Capture Mock Appointment').link(apptExit, 'Capture Live Appointment', 1)
   .link('Capture Mock Appointment', 'Appointment Result').link('Capture Live Appointment', 'Appointment Result')
   .link('Appointment Result', 'Assign Rep', 0).link('Appointment Result', 'Conflict?', 1)
   .link('Conflict?', 'Route Conflict', 0).link('Conflict?', 'Appointment Failed', 1)
   .link('Route Conflict', 'Conflict Reoffer?').link('Conflict Reoffer?', 'Slots Mode?', 0).link('Conflict Reoffer?', 'Handoff Entry', 1)
   .link('Appointment Failed', 'Handoff Entry')
   .link('Assign Rep', 'Rep Result').link('Rep Result', 'Persist Booking').link('Persist Booking', 'Booking Persisted')
   .link('Booking Persisted', 'Dispatch Confirmation').link('Dispatch Confirmation', 'Capture Confirmation')
   .link('Capture Confirmation', 'Build Rep Email').link('Build Rep Email', 'Notify Rep').link('Notify Rep', 'Capture Rep Notice')
   .link('Capture Rep Notice', 'Build Result')
   .link('Slots Mode?', 'GHL Free Slots', 0).link('Slots Mode?', 'Load Busy Slots', 1)
   .link('Load Busy Slots', 'Mock Slots').link(slotsExit, 'Parse Live Slots', 1)
   .link('Mock Slots', 'Build Offer').link('Parse Live Slots', 'Build Offer').link('Build Offer', 'Has Offers?')
   .link('Has Offers?', 'Persist Offer', 0).link('Has Offers?', 'Handoff Entry', 1)
   .link('Persist Offer', 'Offer Persisted').link('Offer Persisted', 'Dispatch Offer').link('Dispatch Offer', 'Capture Offer Dispatch')
   .link('Capture Offer Dispatch', 'Build Result')
   .link('Handoff Entry', 'Persist Handoff').link('Persist Handoff', 'Build Handoff Email')
   .link('Build Handoff Email', 'Send Handoff Email').link('Send Handoff Email', 'Capture Handoff').link('Capture Handoff', 'Build Result')
   .link('Build Result', 'Respond Result').link('Build Result', 'Assert Booking');

  return { file: 'qualifier-booking.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
