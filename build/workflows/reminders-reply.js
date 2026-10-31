const { Workflow, embed, CRED, uid, code, codeAll, ifBool, ifEquals, switchBy, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { REM } = require('./reminders-config');

const WF = 'reminders-reply';
// reminders.js usa ./schedule: debe registrarse primero o el nodo falla al cargar en n8n
const R = exports_ => [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: exports_ }];
const col = n => n * 240;

const ANTHROPIC_PARAMS = jsonBody => ({
  method: 'POST',
  url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true, specifyBody: 'json', jsonBody, options: { timeout: 60000 },
});

// Todo lo que hace falta para decidir, en una sola fila.
const CONTEXT_SQL = `SELECT
  (SELECT to_jsonb(c) FROM appt_contacts c WHERE c.contact_id = $1) AS contact,
  (SELECT to_jsonb(v) FROM appt_conversation v WHERE v.contact_id = $1) AS conversation,
  (SELECT to_jsonb(a) FROM appt_appointments a WHERE a.appointment_id = (SELECT appointment_id FROM appt_conversation WHERE contact_id = $1)) AS appointment,
  (SELECT to_jsonb(s) FROM appt_slots s WHERE s.slot_id = (SELECT offer_slot_id FROM appt_conversation WHERE contact_id = $1)) AS offer_slot,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('slot_id', s.slot_id, 'starts_at', s.starts_at, 'duration_min', s.duration_min, 'service', s.service) ORDER BY s.starts_at)
            FROM appt_slots s WHERE s.status = 'free' AND s.starts_at > $2::timestamptz), '[]'::jsonb) AS free_slots,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'contact_id', w.contact_id, 'service', w.service, 'status', w.status, 'declined_slots', w.declined_slots, 'created_at', w.created_at,
              'contact', to_jsonb(wc)) ORDER BY w.created_at)
            FROM appt_waitlist w JOIN appt_contacts wc ON wc.contact_id = w.contact_id WHERE w.status = 'waiting'), '[]'::jsonb) AS waitlist`;

// ── Efectos: cada uno es UNA sentencia atómica ──
const SQL = {
  confirm: `WITH u AS (UPDATE appt_appointments SET status = 'confirmed', version = version + 1, updated_at = now()
  WHERE appointment_id = $1 AND status IN ('scheduled', 'confirmed') RETURNING appointment_id),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail) SELECT appointment_id, 'confirmed', 'customer', '{"via":"reply"}'::jsonb FROM u RETURNING id)
SELECT (SELECT count(*) FROM u) AS applied`,
  cancel: `WITH u AS (UPDATE appt_appointments SET status = 'cancelled', version = version + 1, updated_at = now()
  WHERE appointment_id = $1 AND status IN ('scheduled', 'confirmed') RETURNING appointment_id),
f AS (UPDATE appt_slots SET status = 'free', appointment_id = NULL WHERE appointment_id = $1 AND EXISTS (SELECT 1 FROM u) RETURNING slot_id),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail) SELECT appointment_id, 'cancelled', 'customer', '{"via":"reply"}'::jsonb FROM u RETURNING id)
SELECT (SELECT count(*) FROM u) AS applied, (SELECT count(*) FROM f) AS freed`,
  // El horario nuevo se reclama con WHERE status = 'free': si otra persona lo tomó un instante antes, claimed = 0 y NADA cambia.
  rebook: `WITH old AS (SELECT * FROM appt_appointments WHERE appointment_id = $1 AND status IN ('scheduled', 'confirmed', 'no_show')),
claim AS (UPDATE appt_slots s SET status = 'booked', appointment_id = $3 WHERE s.slot_id = $2 AND s.status = 'free' AND EXISTS (SELECT 1 FROM old) RETURNING s.slot_id, s.starts_at, s.duration_min),
na AS (INSERT INTO appt_appointments (appointment_id, contact_id, service, starts_at, duration_min, slot_id, status, rescheduled_from)
       SELECT $3, o.contact_id, o.service, c.starts_at, c.duration_min, c.slot_id, 'scheduled', o.appointment_id FROM old o, claim c RETURNING appointment_id),
od AS (UPDATE appt_appointments SET status = CASE WHEN status = 'no_show' THEN status ELSE 'rescheduled' END, rescheduled_to = $3, version = version + 1, updated_at = now()
       WHERE appointment_id = $1 AND EXISTS (SELECT 1 FROM na) RETURNING appointment_id),
fr AS (UPDATE appt_slots SET status = 'free', appointment_id = NULL WHERE appointment_id = $1 AND slot_id <> $2 AND EXISTS (SELECT 1 FROM na) RETURNING slot_id),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail) SELECT $1, 'rescheduled', 'customer', jsonb_build_object('to', $3) FROM na RETURNING id)
SELECT (SELECT count(*) FROM na) AS applied, (SELECT count(*) FROM claim) AS claimed, (SELECT count(*) FROM fr) AS freed`,
  claim_waitlist: `WITH claim AS (UPDATE appt_slots SET status = 'booked', appointment_id = $2 WHERE slot_id = $1 AND status = 'free' RETURNING slot_id, starts_at, duration_min),
na AS (INSERT INTO appt_appointments (appointment_id, contact_id, service, starts_at, duration_min, slot_id, status) SELECT $2, $3, $4, starts_at, duration_min, slot_id, 'scheduled' FROM claim RETURNING appointment_id),
w AS (UPDATE appt_waitlist SET status = 'booked' WHERE contact_id = $3 AND status = 'offered' AND EXISTS (SELECT 1 FROM na) RETURNING id),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail) SELECT appointment_id, 'booked_from_waitlist', 'customer', '{}'::jsonb FROM na RETURNING id)
SELECT (SELECT count(*) FROM na) AS applied`,
  decline_waitlist: `WITH w AS (UPDATE appt_waitlist SET status = 'waiting', declined_slots = declined_slots || to_jsonb($2::text), offered_slot_id = NULL
  WHERE contact_id = $1 AND status = 'offered' RETURNING id)
SELECT (SELECT count(*) FROM w) AS applied`,
  optout: `WITH k AS (INSERT INTO suppression_list (key, reason, contact_id, source)
  SELECT x, 'opt_out_reply', $2, 'reminders-reply' FROM jsonb_array_elements_text($1::jsonb) x ON CONFLICT (key) DO NOTHING RETURNING key)
SELECT (SELECT count(*) FROM k) AS applied`,
};

// Mensajes del cliente, estado de la conversación y ofertas de lista de espera, DESPUÉS de intentar enviar.
const RECORD_SQL = `WITH d AS (SELECT $1::jsonb AS j),
i AS (INSERT INTO appt_messages (contact_id, direction, kind, body, status, execution_id)
      SELECT j->>'contact_id', 'in', 'reply', j->'inbound'->>'text', 'received', j->>'execution_id' FROM d RETURNING id),
o AS (INSERT INTO appt_messages (contact_id, direction, kind, body, status, appointment_id, execution_id)
      SELECT x->>'contact_id', 'out', x->>'kind', x->>'text', CASE WHEN (x->>'ok')::boolean THEN 'sent' ELSE 'failed' END, NULLIF(x->>'appointment_id', ''), d.j->>'execution_id'
      FROM d, jsonb_array_elements(d.j->'outs') x RETURNING id),
c AS (INSERT INTO appt_conversation (contact_id, awaiting, appointment_id, offered_slots, offer_slot_id, attempts, updated_at)
      SELECT d.j->>'contact_id', NULLIF(d.j->'conv'->>'awaiting', ''), NULLIF(d.j->'conv'->>'appointment_id', ''), COALESCE(d.j->'conv'->'offered_slots', '[]'::jsonb), NULLIF(d.j->'conv'->>'offer_slot_id', ''), COALESCE((d.j->'conv'->>'attempts')::int, 0), now() FROM d
      ON CONFLICT (contact_id) DO UPDATE SET awaiting = EXCLUDED.awaiting, appointment_id = EXCLUDED.appointment_id, offered_slots = EXCLUDED.offered_slots, offer_slot_id = EXCLUDED.offer_slot_id, attempts = EXCLUDED.attempts, updated_at = now()
      RETURNING contact_id),
w AS (UPDATE appt_waitlist w SET status = 'offered', offered_slot_id = x->>'slot_id' FROM d, jsonb_array_elements(d.j->'offers') x WHERE w.id = (x->>'entry_id')::bigint AND w.status = 'waiting' RETURNING w.id),
wc AS (INSERT INTO appt_conversation (contact_id, awaiting, offered_slots, offer_slot_id, attempts, updated_at)
       SELECT x->>'contact_id', 'waitlist_offer', '[]'::jsonb, x->>'slot_id', 0, now() FROM d, jsonb_array_elements(d.j->'offers') x
       ON CONFLICT (contact_id) DO UPDATE SET awaiting = 'waitlist_offer', appointment_id = NULL, offered_slots = '[]'::jsonb, offer_slot_id = EXCLUDED.offer_slot_id, attempts = 0, updated_at = now()
       RETURNING contact_id)
SELECT (SELECT count(*) FROM i) AS inbound, (SELECT count(*) FROM o) AS outbound, (SELECT count(*) FROM c) AS conv, (SELECT count(*) FROM w) AS offers`;

const LIBS = [{ file: 'schedule', exports: ['inferTimezone'] }, { file: 'reminders', exports: ['decideReply', 'waitlistPick', 'slotLabel', 'replyText', 'offerSlotsMessage', 'waitlistOfferMessage', 'clean'] }];

module.exports = function remindersReply() {
  const w = Workflow('reminderreply001', 'Reminders · Customer Reply (Auditable)');

  // ── Entrada + validación + idempotencia ──
  w.add('Reply Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'reminder-reply', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Respuesta entrante normalizada: {message_id, contact_id, text}. En live la dispara GoHighLevel (mensaje entrante). Protegido por x-reminders-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500], { mode: 'raw', jsonOutput: JSON.stringify({ config: REM }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Reply', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    R(['normalizeReply']),
    `const item = $input.item.json;
const c = item.config;
const n = normalizeReply(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-reminders-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { reply: n.reply, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: ids seguros, texto y tamaño. received_at solo en mock con token.' })
   .add('Valid Reply?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1500], 400, '{ status: "rejected", errors: $json.validation.errors }');
  idempotency(w, { workflow: WF, position: [col(4), 400], paramCount: 1, params: '$json.reply.message_id', stateFrom: 'Normalize Reply', check: 'New message?', keySql: "'appt-msg:' || $1" });
  respond(w, 'Duplicate 200', [col(7), 800], 200, '{ status: "duplicate", message_id: $json.reply.message_id }');
  respond(w, 'Accepted 202', [col(7), 400], 202, '{ status: "accepted", message_id: $json.reply.message_id }');

  // ── Interpretar (sin IA) + contexto ──
  w.add('Parse Reply', 'n8n-nodes-base.code', 2, [col(8), 400], code(embed(
    [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: ['parseReply'] }],
    `const s = $input.item.json;
return { json: { ...s, now: s.reply.received_at || new Date().toISOString(), parsed: parseReply(s.reply.text) } };`)),
    { notes: 'DETERMINÍSTICO: baja (STOP/baja), números 1-9 y palabras exactas (yes, cancel, reschedule). Todo lo demás es texto libre.' });
  pg(w, 'Load Context', [col(9), 400], CONTEXT_SQL, '[$json.reply.contact_id, $json.now]',
    { alwaysOutputData: true, notes: 'Contacto, qué espera su conversación, la cita, los horarios libres y la lista de espera: una sola fila.' });
  w.add('Merge Context', 'n8n-nodes-base.code', 2, [col(10), 400], code(
    `const s = $('Parse Reply').item.json;
const r = $input.item.json;
const ctx = { contact: r.contact || null, conversation: r.conversation || null, appointment: r.appointment || null, offer_slot: r.offer_slot || null, free_slots: r.free_slots || [], waitlist: r.waitlist || [] };
const needsAi = s.parsed.kind === 'free_text' && !!ctx.conversation && ctx.conversation.awaiting === 'reminder';
return { json: { ...s, ctx, needs_ai: needsAi } };`))
   .add('Needs AI?', 'n8n-nodes-base.if', 2.2, [col(11), 400], ifBool('={{ $json.needs_ai }}'));

  // ── Solo texto libre: la IA clasifica la intención ──
  w.add('Classify AI Mode?', 'n8n-nodes-base.if', 2.2, [col(12), 240], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Classify Request', 'n8n-nodes-base.code', 2, [col(13), 120], code(embed(
    R(['buildClassifyRequest']),
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClassifyRequest(s.parsed.text, s.config.model) } };`)),
    { notes: 'La respuesta va dentro de <reply>: es DATO, nunca instrucciones.' })
   .add('Mock Classify', 'n8n-nodes-base.code', 2, [col(13), 360], code(embed(
    R(['mockClassifyReply']),
    `const s = $input.item.json;
return { json: { ...s, ai: mockClassifyReply(s.parsed.text) } };`)),
    { notes: 'Sustituto local de Claude por palabras clave. [[mock:ai_down]] simula la caída del modelo.' });
  const aiExit = httpWithBackoff(w, {
    name: 'Claude Classify', position: [col(14), 120], source: 'Build Classify Request', workflow: WF, entity: '$json.reply.message_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (tool record_reply_intent).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Classification', 'n8n-nodes-base.code', 2, [col(17), 120], code(embed(
    R(['parseClassify']),
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, ai: parseClassify(http_response) } };`)),
    { notes: 'Valida intención, rango de confianza y evidencia. Si es inválida, falla cerrado (una persona).' })
   .add('Ground Intent', 'n8n-nodes-base.code', 2, [col(18), 240], code(embed(
    R(['groundIntent']),
    `const s = $input.item.json;
const ai = s.ai.ok ? { ok: true, classification: groundIntent(s.ai.classification, s.parsed.text) } : s.ai;
return { json: { ...s, ai } };`)),
    { notes: 'DETERMINÍSTICO: la evidencia que cita la IA debe estar en el texto del cliente; si no, la confianza pasa a 0.' });

  // ── Decidir (código) ──
  w.add('Decide Reply', 'n8n-nodes-base.code', 2, [col(19), 400], code(embed(LIBS,
    `const s = $input.item.json;
const c = s.config, ctx = s.ctx, contact = ctx.contact, appt = ctx.appointment, cid = s.reply.contact_id;
const tz = contact ? inferTimezone(contact, c).tz : c.defaultTimezone;
const d = decideReply({ parsed: s.parsed, ai: s.ai || null, conversation: ctx.conversation, appointment: appt, freeSlots: ctx.free_slots, now: s.now }, c);
const label = iso => slotLabel(iso, tz);
let effect = { kind: 'none' }, replyKind = d.kind, vars = {}, conv = { awaiting: null }, freed = null;
const apptFreed = appt ? { slot_id: appt.slot_id, starts_at: appt.starts_at, service: appt.service } : null;
switch (d.kind) {
  case 'optout': effect = { kind: 'optout', keys: [contact && contact.email ? contact.email.toLowerCase() : null, contact && contact.phone ? contact.phone : null].filter(Boolean) }; break;
  case 'confirm': effect = { kind: 'confirm', appointment_id: appt.appointment_id }; break;
  case 'cancel': effect = { kind: 'cancel', appointment_id: appt.appointment_id }; freed = apptFreed; break;
  case 'offer_slots': conv = { awaiting: 'slot_choice', appointment_id: appt.appointment_id, offered_slots: d.slots, attempts: 0 }; break;
  case 'rebook': effect = { kind: 'rebook', appointment_id: appt.appointment_id, slot_id: d.slot.slot_id, new_appointment_id: appt.appointment_id + '~' + d.slot.slot_id }; vars = { label: label(d.slot.starts_at) }; freed = apptFreed; break;
  case 'claim_waitlist': { const o = ctx.offer_slot; const sid = ctx.conversation.offer_slot_id; effect = { kind: 'claim_waitlist', slot_id: sid, new_appointment_id: 'wl~' + sid + '~' + cid, service: (o && o.service) || 'Consultation' }; replyKind = 'waitlist_claimed'; vars = { label: o ? label(o.starts_at) : '' }; break; }
  case 'decline_waitlist': { const o = ctx.offer_slot; effect = { kind: 'decline_waitlist', slot_id: ctx.conversation.offer_slot_id }; replyKind = 'waitlist_declined'; freed = o ? { slot_id: o.slot_id, starts_at: o.starts_at, service: o.service } : null; break; }
  case 'reprompt': { const v = ctx.conversation; conv = { awaiting: v.awaiting, appointment_id: v.appointment_id, offered_slots: v.offered_slots, offer_slot_id: v.offer_slot_id, attempts: (v.attempts || 0) + 1 }; replyKind = 'reprompt_' + v.awaiting; break; }
  default: break; // closed | handoff
}
const pick = freed ? waitlistPick(ctx.waitlist.filter(x => x.contact_id !== cid), freed) : null;
return { json: { ...s, decision: d, effect, reply_kind: replyKind, reply_vars: vars, conv, freed, wl_pick: pick ? { entry_id: pick.id, contact: pick.contact, slot: freed } : null, tz } };`)),
    { notes: 'DETERMINÍSTICO. Máquina de estados: el recordatorio admite 1 confirmar / 2 reagendar / 3 cancelar; tras 2 se eligen horarios por número; la lista de espera admite 1 tomar / 2 pasar. Texto libre solo actúa si la IA es confiable y su evidencia está en el texto; inyección, IA caída o duda → una persona. Dos opciones inválidas seguidas → una persona.' })
   .add('Apply Effect', 'n8n-nodes-base.switch', 3.2, [col(20), 400], switchBy('={{ $json.effect.kind }}', ['confirm', 'cancel', 'rebook', 'claim_waitlist', 'decline_waitlist', 'optout', 'none']),
    { notes: 'Un efecto por rama; cada uno es UNA sentencia atómica en Postgres.' });
  pg(w, 'Apply · confirm', [col(21), 40], SQL.confirm, '[$json.effect.appointment_id]', { alwaysOutputData: true, notes: 'Confirma solo si la cita sigue activa.' });
  pg(w, 'Apply · cancel', [col(21), 200], SQL.cancel, '[$json.effect.appointment_id]', { alwaysOutputData: true, notes: 'Cancela la cita y libera su horario en una sola sentencia.' });
  pg(w, 'Apply · rebook', [col(21), 360], SQL.rebook, '[$json.effect.appointment_id, $json.effect.slot_id, $json.effect.new_appointment_id]', { alwaysOutputData: true, notes: 'El horario nuevo se reclama solo si sigue libre: si otra persona lo tomó, NADA cambia. Crea la cita nueva enlazada, marca la vieja como reagendada y libera su horario.' });
  pg(w, 'Apply · claim_waitlist', [col(21), 520], SQL.claim_waitlist, '[$json.effect.slot_id, $json.effect.new_appointment_id, $json.reply.contact_id, $json.effect.service]', { alwaysOutputData: true, notes: 'Gana el primero en responder: el horario se reclama solo si sigue libre.' });
  pg(w, 'Apply · decline_waitlist', [col(21), 680], SQL.decline_waitlist, '[$json.reply.contact_id, $json.effect.slot_id]', { alwaysOutputData: true, notes: 'La persona vuelve a la lista sin ese horario; la oferta pasa a la siguiente.' });
  pg(w, 'Apply · optout', [col(21), 840], SQL.optout, '[JSON.stringify($json.effect.keys), $json.reply.contact_id]', { alwaysOutputData: true, notes: 'La baja va a la lista de supresión compartida (la misma que Revival). Nunca se borra desde los flujos.' });
  w.add('Effect Result', 'n8n-nodes-base.code', 2, [col(22), 400], code(
    `const s = $('Decide Reply').item.json;
const r = $input.item.json;
const kind = s.effect.kind;
let replyKind = s.reply_kind, conv = s.conv, pick = s.wl_pick;
const applied = kind === 'none' ? null : Number(r.applied);
if ((kind === 'confirm' || kind === 'cancel') && applied === 0) { replyKind = 'closed'; pick = null; }
if (kind === 'rebook' && applied === 0) { replyKind = 'slot_taken'; conv = { awaiting: 'reminder', appointment_id: s.effect.appointment_id, attempts: 0 }; pick = null; }
if (kind === 'claim_waitlist' && applied === 0) { replyKind = 'slot_taken'; pick = null; }
if (kind === 'decline_waitlist' && applied === 0) pick = null;
return { json: { ...s, effect_result: { kind, applied }, reply_kind: replyKind, conv, wl_pick: pick } };`),
    { notes: 'Si el efecto no se aplicó (la cita ya no estaba activa o el horario ya lo tomó otra persona) la respuesta lo dice y no se ofrece nada a la lista de espera.' })
   .add('Plan Messages', 'n8n-nodes-base.code', 2, [col(23), 400], code(embed(LIBS,
    `const s = $input.item.json;
const c = s.config, contact = s.ctx.contact;
const addr = ct => ct.email || (ct.phone ? String(ct.phone).replace(/\\D/g, '') + '@sms.demo.test' : null);
const msgs = [];
if (contact && addr(contact)) {
  const text = s.reply_kind === 'offer_slots' ? offerSlotsMessage(s.decision.slots, s.tz) : replyText(s.reply_kind, s.reply_vars);
  msgs.push({ to: addr(contact), phone: contact.phone, contact_id: contact.contact_id, kind: 'reply_' + s.reply_kind, text, appointment_id: s.ctx.appointment ? s.ctx.appointment.appointment_id : '' });
}
if (s.decision.kind === 'handoff' || !contact) {
  const reason = !contact ? 'unknown_contact' : s.decision.reasons.join(',');
  msgs.push({ to: c.ownerEmail, phone: '', contact_id: s.reply.contact_id, kind: 'handoff_staff', appointment_id: '', text: ['A customer reply needs a person.', 'Contact: ' + clean(contact ? contact.name : '(unknown)') + ' (' + clean(s.reply.contact_id) + ')', 'Reason: ' + reason, 'Their message: "' + clean(s.reply.text, 300) + '"'].join('\\n') });
}
if (s.wl_pick && s.wl_pick.contact && addr(s.wl_pick.contact)) {
  const tz2 = inferTimezone(s.wl_pick.contact, c).tz;
  msgs.push({ to: addr(s.wl_pick.contact), phone: s.wl_pick.contact.phone, contact_id: s.wl_pick.contact.contact_id, kind: 'waitlist_offer', appointment_id: '', entry_id: s.wl_pick.entry_id, slot_id: s.wl_pick.slot.slot_id, text: waitlistOfferMessage(s.wl_pick.slot, tz2) });
}
return { json: { ...s, msgs } };`)),
    { notes: 'La respuesta al cliente, el aviso a una persona si hay que pasarla a alguien, y la oferta al siguiente de la lista de espera si se liberó un horario. Todo dato del cliente se sanea.' })
   .add('Expand Messages', 'n8n-nodes-base.code', 2, [col(24), 400], codeAll(
    `const s = $input.first().json;
return s.msgs.map(m => ({ json: { from: s.config.fromEmail, ...m } }));`))
   .add('Send Message (SMS mock)', 'n8n-nodes-base.emailSend', 2.1, [col(25), 400], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: "={{ $json.kind === 'handoff_staff' ? 'Reminder reply needs a person' : 'SMS · ' + ($json.phone || $json.to) }}",
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'En local el SMS es un correo a Mailpit. En live: GoHighLevel (contrato SIN verificar).' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(26), 400], codeAll(
    `const s = $('Plan Messages').first().json;
const out = $('Expand Messages').all();
const outs = $input.all().map((r, i) => ({ to: out[i].json.to, contact_id: out[i].json.contact_id, kind: out[i].json.kind, text: out[i].json.text, appointment_id: out[i].json.appointment_id || '', entry_id: out[i].json.entry_id, slot_id: out[i].json.slot_id, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const offers = outs.filter(o => o.ok && o.kind === 'waitlist_offer').map(o => ({ entry_id: o.entry_id, contact_id: o.contact_id, slot_id: o.slot_id }));
return [{ json: { ...s, outs, offers, failed: outs.filter(o => !o.ok).map(o => ({ to: o.to, kind: o.kind, error: o.error })), execution_id: String($execution.id) } }];`),
    { notes: 'Una oferta de lista de espera cuenta solo si el mensaje salió.' });
  pg(w, 'Record Outcome', [col(27), 400], RECORD_SQL, '[JSON.stringify({ contact_id: $json.reply.contact_id, inbound: { text: $json.reply.text }, outs: $json.outs, conv: $json.conv, offers: $json.offers, execution_id: $json.execution_id })]',
    { alwaysOutputData: true, notes: 'El mensaje del cliente, lo que se envió, el nuevo estado de la conversación y las ofertas de lista de espera, en una sola sentencia.' });
  w.add('Reply Result', 'n8n-nodes-base.code', 2, [col(28), 400], code(
    `const s = $('Collect Sends').item.json;
const r = $input.item.json;
return { json: { ...s, result: { status: s.failed.length ? 'failed' : 'ok', message_id: s.reply.message_id, decision: s.decision.kind, reasons: s.decision.reasons, reply: s.reply_kind, effect: s.effect_result, offers: s.offers.length, failed: s.failed, inbound_logged: Number(r.inbound) } } };`));
  markIdempotency(w, { position: [col(29), 300], keyExpr: '$json.idem.key', statusExpr: "'done'", resultExpr: '({ decision: $json.result.decision, reply: $json.result.reply })' });
  w.add('Assert Reply', 'n8n-nodes-base.code', 2, [col(29), 520], code(
    `const r = $input.item.json.result;
if (r.failed.length > 0) throw new Error('Reminder reply ' + r.message_id + ': ' + r.failed.length + ' message(s) failed: ' + r.failed.map(f => f.kind + ' -> ' + f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log escritos → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.reply.message_id', ...o });
  L('Normalize Reply', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'message_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Parse Reply', { step: 'parsed', detail: '({ kind: $json.parsed.kind, n: $json.parsed.n ?? null })' });
  L('Decide Reply', { step: 'decided', status: "['handoff', 'closed'].includes($json.decision.kind) ? 'skipped' : 'ok'", error: "$json.decision.reasons.join(',')", detail: '({ decision: $json.decision.kind, reasons: $json.decision.reasons, effect: $json.effect.kind, awaiting: $json.ctx.conversation ? $json.ctx.conversation.awaiting : null })' });
  L('Effect Result', { step: 'effect_applied', status: "$json.effect_result.applied === 0 ? 'skipped' : 'ok'", error: "$json.effect_result.applied === 0 ? 'not_applied' : ''", detail: '({ effect: $json.effect_result })' });
  L('Collect Sends', { step: 'messages_sent', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.kind).join(',')", detail: '({ outs: $json.outs.map(o => ({ kind: o.kind, ok: o.ok })) })' });
  L('Reply Result', { step: 'completed', status: "$json.result.failed.length ? 'failed' : 'ok'", detail: '({ result: $json.result })' });

  w.note('## Reminders · Customer Reply\nOpt-out first (code). Numbers and exact words are read by code; only free text goes to the AI, and only to classify the intent with its evidence. Code decides, applies the effect in one atomic statement, answers the customer, offers a freed slot to the waitlist, and hands anything doubtful to a person.', [col(0) - 20, -150], col(18), 130);

  // ── Conexiones ──
  w.link('Reply Webhook', 'Config').link('Config', 'Normalize Reply').link('Normalize Reply', 'Valid Reply?')
   .link('Valid Reply?', 'Claim Idempotency', 0).link('Valid Reply?', 'Respond 400', 1)
   .link('New message?', 'Accepted 202', 0).link('New message?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Parse Reply').link('Parse Reply', 'Load Context').link('Load Context', 'Merge Context').link('Merge Context', 'Needs AI?')
   .link('Needs AI?', 'Classify AI Mode?', 0).link('Needs AI?', 'Decide Reply', 1)
   .link('Classify AI Mode?', 'Build Classify Request', 0).link('Classify AI Mode?', 'Mock Classify', 1)
   .link('Build Classify Request', 'Claude Classify').link(aiExit, 'Parse Classification', 1)
   .link('Parse Classification', 'Ground Intent').link('Mock Classify', 'Ground Intent').link('Ground Intent', 'Decide Reply')
   .link('Decide Reply', 'Apply Effect')
   .link('Apply Effect', 'Apply · confirm', 0).link('Apply Effect', 'Apply · cancel', 1).link('Apply Effect', 'Apply · rebook', 2)
   .link('Apply Effect', 'Apply · claim_waitlist', 3).link('Apply Effect', 'Apply · decline_waitlist', 4).link('Apply Effect', 'Apply · optout', 5)
   .link('Apply Effect', 'Effect Result', 6)
   .link('Apply · confirm', 'Effect Result').link('Apply · cancel', 'Effect Result').link('Apply · rebook', 'Effect Result')
   .link('Apply · claim_waitlist', 'Effect Result').link('Apply · decline_waitlist', 'Effect Result').link('Apply · optout', 'Effect Result')
   .link('Effect Result', 'Plan Messages').link('Plan Messages', 'Expand Messages').link('Expand Messages', 'Send Message (SMS mock)').link('Send Message (SMS mock)', 'Collect Sends')
   .link('Collect Sends', 'Record Outcome').link('Record Outcome', 'Reply Result')
   .link('Reply Result', 'Mark Idempotency').link('Reply Result', 'Assert Reply');

  return { file: 'reminders-reply.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
