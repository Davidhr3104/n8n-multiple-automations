const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/revival');

const NOW = '2026-10-13T12:00:00.000Z';
const c = (id, email, phone, kind = 'new', extra = {}) => ({ contact_id: id, name: id, email, phone, kind, touch: kind === 'new' ? 1 : 2, ...extra });

// ───────────── selectCandidates ─────────────
test('selectCandidates: descarta contactos sin email ni teléfono válido', () => {
  const r = R.selectCandidates([c('a', 'no-email', null), c('b', 'b@x.com', null)], { max: 10, suppressed: new Set() });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['b']);
  assert.deepEqual(r.skipped, [{ contact_id: 'a', reason: 'invalid_contact' }]);
});

test('selectCandidates: lista de bajas por email o por teléfono (normalizado)', () => {
  const sup = new Set(['bad@x.com', '+573001112233']);
  const r = R.selectCandidates([c('a', 'BAD@x.com', null), c('b', 'ok@x.com', '300 111 2233'), c('c', 'c@x.com', '+57 300 111 2233'), c('d', 'd@x.com', null)], { max: 10, suppressed: sup, defaultCountryCode: '57' });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['d']);
  assert.deepEqual(r.skipped.map(x => x.reason), ['suppressed', 'suppressed', 'suppressed']);
});

test('normalizePhone: un número largo sin "+" ya trae su código de país (no se le añade el de por defecto)', () => {
  assert.equal(R.normalizePhone('5255 1111 0002', '57'), '+525511110002');
  assert.equal(R.normalizePhone('+52 55 1111 0002', '57'), '+525511110002');
  assert.equal(R.normalizePhone('300 111 2233', '57'), '+573001112233');
  assert.equal(R.normalizePhone('123', '57'), null);
});

test('selectCandidates: el mismo teléfono escrito con y sin "+" es un duplicado', () => {
  const r = R.selectCandidates([c('a', 'a@x.com', '+52 55 1111 0002'), c('b', 'b@x.com', '5255 1111 0002')], { max: 10, suppressed: new Set(), defaultCountryCode: '57' });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['a']);
  assert.deepEqual(r.skipped, [{ contact_id: 'b', reason: 'duplicate_of:a' }]);
});

test('selectCandidates: deduplica por email o teléfono; gana el primero', () => {
  const r = R.selectCandidates([c('a', 'x@x.com', '+1 555 000 1111'), c('b', 'X@x.com', null), c('c', 'c@x.com', '+15550001111')], { max: 10, suppressed: new Set() });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['a']);
  assert.deepEqual(r.skipped, [{ contact_id: 'b', reason: 'duplicate_of:a' }, { contact_id: 'c', reason: 'duplicate_of:a' }]);
});

test('selectCandidates: follow-ups van primero y el tope se aplica al total', () => {
  const rows = [c('n1', 'n1@x.com', null), c('n2', 'n2@x.com', null), c('f1', 'f1@x.com', null, 'follow_up')];
  const r = R.selectCandidates(rows, { max: 2, suppressed: new Set() });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['f1', 'n1']);
  assert.deepEqual(r.skipped, [{ contact_id: 'n2', reason: 'over_cap' }]);
});

test('selectCandidates: un duplicado de alguien YA en secuencia no recibe primer toque (engaged)', () => {
  const engaged = new Set(['ana@x.com', '+573001112233']);
  const rows = [c('n1', 'ANA@x.com', null), c('n2', 'otro@x.com', '300 111 2233'), c('n3', 'libre@x.com', null), c('f1', 'ana@x.com', null, 'follow_up')];
  const r = R.selectCandidates(rows, { max: 10, suppressed: new Set(), engaged, defaultCountryCode: '57' });
  assert.deepEqual(r.selected.map(x => x.contact_id), ['f1', 'n3']);
  assert.deepEqual(r.skipped, [{ contact_id: 'n1', reason: 'already_in_sequence' }, { contact_id: 'n2', reason: 'already_in_sequence' }]);
});

// ───────────── nextTouchAt ─────────────
test('nextTouchAt: espacia según gapDays y termina tras el último toque', () => {
  assert.equal(R.nextTouchAt(1, { gapDays: [3, 5], maxTouches: 3 }, NOW), '2026-10-16T12:00:00.000Z');
  assert.equal(R.nextTouchAt(2, { gapDays: [3, 5], maxTouches: 3 }, NOW), '2026-10-18T12:00:00.000Z');
  assert.equal(R.nextTouchAt(3, { gapDays: [3, 5], maxTouches: 3 }, NOW), null);
});

// ───────────── detectOptOut ─────────────
test('detectOptOut: frases de baja en español e inglés', () => {
  for (const t of ['STOP', 'Stop please', 'BAJA', 'por favor denme de baja', 'no me escriban más', 'unsubscribe me', 'Do not contact me again', 'quítenme de la lista', 'Dejen de escribirme']) {
    assert.equal(R.detectOptOut(t).optOut, true, t);
  }
});

test('detectOptOut: no confunde frases parecidas con una baja', () => {
  for (const t of ['no dejen de escribirme, me interesa', 'Me interesa, ¿tienen demo?', 'non-stop support sounds great', 'quiero agendar una llamada', 'baja latencia es importante para nosotros']) {
    assert.equal(R.detectOptOut(t).optOut, false, t);
  }
});

// ───────────── mensaje: construcción, validación y finalización ─────────────
const contact = { name: 'Ana Torres', company: 'Acme', history: [{ date: '2026-05-01', type: 'note', text: 'Pidió cotización de automatización de WhatsApp' }] };

test('buildTouchRequest: historial como dato no confiable, sin temperature, tool forzada', () => {
  const b = R.buildTouchRequest(contact, 2, { maxTouches: 3 }, 'claude-sonnet-5-5');
  assert.equal(b.tool_choice.name, 'record_message');
  assert.equal(b.temperature, undefined);
  assert.match(b.system, /untrusted/i);
  assert.match(JSON.stringify(b.messages), /<history>/);
  assert.match(JSON.stringify(b.messages), /touch 2 of 3/i);
});

test('parseTouchResponse: valida o falla explícito', () => {
  const wrap = input => ({ content: [{ type: 'tool_use', name: 'record_message', input }] });
  assert.equal(R.parseTouchResponse(wrap({ message: 'Hola Ana, ¿sigues interesada en automatizar WhatsApp?' })).ok, true);
  assert.equal(R.parseTouchResponse(wrap({ message: 'x' })).ok, false);
  assert.equal(R.parseTouchResponse(wrap({})).ok, false);
  assert.equal(R.parseTouchResponse({ error: { message: 'boom' } }).ok, false);
  assert.equal(R.parseTouchResponse(undefined).ok, false);
});

test('mockTouch: determinístico, referencia el historial, varía por toque', () => {
  const t1 = R.mockTouch(contact, 1), t2 = R.mockTouch(contact, 2), t3 = R.mockTouch(contact, 3);
  assert.match(t1, /Ana/);
  assert.match(t1, /WhatsApp/);
  assert.notEqual(t1, t2);
  assert.notEqual(t2, t3);
  assert.equal(R.mockTouch(contact, 1), t1);
});

test('finalizeMessage: agrega SIEMPRE el pie de baja (determinístico) y respeta el idioma', () => {
  const es = R.finalizeMessage('Hola Ana, ¿retomamos lo de WhatsApp? Necesitamos hablar.');
  assert.equal(es.ok, true);
  assert.match(es.text, /BAJA/);
  const en = R.finalizeMessage('Hi Ana, shall we pick up where we left off about the quote?');
  assert.match(en.text, /STOP/);
});

test('finalizeMessage: rechaza URLs, promesas de precio/garantías y mensajes largos (no se envía)', () => {
  assert.deepEqual(R.finalizeMessage('Mira https://evil.com ahora').issues, ['contains_url']);
  assert.ok(R.finalizeMessage('Te lo damos GRATIS con garantía total').issues.includes('forbidden_claim'));
  assert.ok(R.finalizeMessage('Solo $99 al mes').issues.includes('forbidden_claim'));
  assert.ok(R.finalizeMessage('a'.repeat(700)).issues.includes('too_long'));
  assert.equal(R.finalizeMessage('Mira https://evil.com').ok, false);
});

// ───────────── respuestas del lead ─────────────
test('parseClassification: valida etiqueta y confianza', () => {
  const wrap = input => ({ content: [{ type: 'tool_use', name: 'record_classification', input }] });
  const ok = R.parseClassification(wrap({ label: 'interested', confidence: 0.9, rationale: 'pide demo' }));
  assert.deepEqual([ok.ok, ok.label, ok.confidence], [true, 'interested', 0.9]);
  assert.equal(R.parseClassification(wrap({ label: 'maybe', confidence: 0.9 })).ok, false);
  assert.equal(R.parseClassification(wrap({ label: 'interested', confidence: 2 })).ok, false);
  assert.equal(R.parseClassification({ error: { message: 'x' } }).ok, false);
});

test('mockClassify: etiquetas por palabras clave', () => {
  assert.equal(R.mockClassify('Quiero agendar una llamada mañana').label, 'schedule');
  assert.equal(R.mockClassify('Me interesa, ¿cuánto cuesta?').label, 'interested');
  assert.equal(R.mockClassify('No me interesa, gracias').label, 'not_interested');
  assert.equal(R.mockClassify('mmm').label, 'unclear');
});

test('routeReply: baja siempre suprime; interés pide aprobación; confianza baja va a revisión', () => {
  const cfg = { replyConfidenceThreshold: 0.6 };
  assert.equal(R.routeReply({ label: 'unsubscribe', confidence: 0.2 }, cfg).action, 'suppress');
  assert.equal(R.routeReply({ label: 'interested', confidence: 0.9 }, cfg).action, 'approve_booking');
  assert.equal(R.routeReply({ label: 'schedule', confidence: 0.8 }, cfg).action, 'approve_booking');
  assert.equal(R.routeReply({ label: 'not_interested', confidence: 0.9 }, cfg).action, 'close');
  assert.equal(R.routeReply({ label: 'interested', confidence: 0.4 }, cfg).action, 'review');
  assert.equal(R.routeReply({ label: 'unclear', confidence: 0.9 }, cfg).action, 'review');
});

test('bookingMessage: determinístico, con el link de la config (la IA no escribe URLs)', () => {
  const m = R.bookingMessage({ name: 'Ana Torres' }, 'https://cal.example.com/demo', 'es');
  assert.match(m, /Ana/);
  assert.match(m, /https:\/\/cal\.example\.com\/demo/);
});

// ───────────── guarda de envío ─────────────
test('canSend: exige lote aprobado, sin baja, estado válido y orden de toques', () => {
  const ok = { batch_status: 'approved', suppressed: false, state_status: 'new', step: 0 };
  assert.equal(R.canSend(ok, 1, { maxTouches: 3 }).ok, true);
  assert.equal(R.canSend({ ...ok, batch_status: 'pending_approval' }, 1, { maxTouches: 3 }).reason, 'batch_not_approved');
  assert.equal(R.canSend({ ...ok, suppressed: true }, 1, { maxTouches: 3 }).reason, 'suppressed');
  assert.equal(R.canSend({ ...ok, state_status: 'opted_out' }, 1, { maxTouches: 3 }).reason, 'state_opted_out');
  assert.equal(R.canSend({ ...ok, state_status: 'active', step: 1 }, 1, { maxTouches: 3 }).reason, 'wrong_touch_order');
  assert.equal(R.canSend({ ...ok, state_status: 'active', step: 1 }, 2, { maxTouches: 3 }).ok, true);
  assert.equal(R.canSend(ok, 4, { maxTouches: 3 }).reason, 'touch_out_of_range');
  assert.equal(R.canSend(undefined, 1, { maxTouches: 3 }).ok, false);
});
