const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/review');
const { finalizeMessage } = require('../lib/revival');

const draft = (id, extra = {}) => ({
  id, contact_name: `Contact ${id}`, email: `c${id}@x.com`, company: 'Acme', touch: 1, kind: 'new', status: 'pending_review',
  body_core: `Hola ${id}, ¿sigue siendo una prioridad?\n— Equipo Demo`, send_note: 'Sends right away (09:00-19:00 local)', tz: 'America/Bogota', tz_source: 'phone', ...extra,
});
const ctx = (drafts, extra = {}) => ({ batch: { batch_id: 'rev_1', token: 'tok123', size: drafts.length, expires_at: '2026-10-24T12:00:00.000Z' }, drafts, submitUrl: '/webhook/revival-review-submit', dataLabel: 'TEST DATA', ...extra });

// ───────────── renderReviewPage ─────────────
test('página de revisión: cada borrador listo tiene etiqueta, textarea editable y elección Enviar/Saltar', () => {
  const html = V.renderReviewPage(ctx([draft(1), draft(2)]));
  assert.match(html, /<form[^>]+method="post"[^>]+action="\/webhook\/revival-review-submit"/i);
  assert.match(html, /name="batch" value="rev_1"/);
  assert.match(html, /name="token" value="tok123"/);
  for (const id of [1, 2]) {
    assert.match(html, new RegExp(`<label[^>]+for="b_${id}"`));
    assert.match(html, new RegExp(`<textarea[^>]+id="b_${id}"[^>]+name="b_${id}"`));
    assert.match(html, new RegExp(`name="d_${id}" value="send" checked`));
    assert.match(html, new RegExp(`name="d_${id}" value="skip"`));
  }
  assert.match(html, /TEST DATA/);
  assert.match(html, /Skip to review/i); // enlace de salto
});

test('página de revisión: TODO dato no confiable va escapado (nombre, empresa, texto del borrador, motivo)', () => {
  const evil = '<script>alert(1)</script>';
  const html = V.renderReviewPage(ctx([
    draft(1, { contact_name: evil, company: evil, body_core: `x ${evil}` }),
    draft(2, { status: 'blocked', blocked_reason: `contains_url ${evil}` }),
  ]));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('página de revisión: los borradores bloqueados o fallidos se muestran con su motivo y SIN controles de envío', () => {
  const html = V.renderReviewPage(ctx([draft(1), draft(2, { status: 'blocked', blocked_reason: 'contains_url,forbidden_claim' }), draft(3, { status: 'failed', blocked_reason: 'ai_failed' })]));
  assert.match(html, /contains_url,forbidden_claim/);
  assert.ok(!html.includes('name="d_2"') && !html.includes('name="b_2"'));
  assert.ok(!html.includes('name="d_3"'));
  assert.match(html, /1 ready/i);
  assert.match(html, /2 .*(blocked|need)/i);
});

test('página de revisión: sin borradores listos no hay botón de envío', () => {
  const html = V.renderReviewPage(ctx([draft(1, { status: 'blocked', blocked_reason: 'x' })]));
  assert.ok(!/<button[^>]+type="submit"/.test(html));
});

// ───────────── applyReview ─────────────
const pending = [draft(1), draft(2), draft(3)];

test('applyReview: enviar aprueba, saltar descarta, y el pie de baja se agrega siempre', () => {
  const r = V.applyReview(pending, { d_1: 'send', b_1: pending[0].body_core, d_2: 'skip', b_2: pending[1].body_core, d_3: 'send', b_3: pending[2].body_core }, finalizeMessage);
  const by = Object.fromEntries(r.decisions.map(d => [d.id, d]));
  assert.equal(by[1].status, 'approved');
  assert.match(by[1].body, /BAJA|STOP/);
  assert.equal(by[2].status, 'skipped');
  assert.deepEqual([r.summary.approved, r.summary.skipped, r.summary.edited], [2, 1, 0]);
});

test('applyReview: editar marca edited y guarda el texto nuevo', () => {
  const r = V.applyReview([draft(1)], { d_1: 'send', b_1: 'Hola, ¿retomamos lo de WhatsApp?' }, finalizeMessage);
  assert.equal(r.decisions[0].status, 'approved');
  assert.equal(r.decisions[0].edited, true);
  assert.equal(r.decisions[0].body_core, 'Hola, ¿retomamos lo de WhatsApp?');
  assert.equal(r.summary.edited, 1);
});

test('applyReview: un texto editado con URL o promesas NO se envía (se salta con el motivo)', () => {
  const r = V.applyReview([draft(1), draft(2)], { d_1: 'send', b_1: 'Mira https://evil.com ya', d_2: 'send', b_2: 'Te damos GRATIS todo' }, finalizeMessage);
  for (const d of r.decisions) { assert.equal(d.status, 'skipped'); assert.match(d.reason, /^edit_rejected:/); }
  assert.equal(r.summary.rejected_edits.length, 2);
});

test('applyReview: falla cerrado — sin elección, valor raro o texto vacío => saltar', () => {
  const r = V.applyReview(pending, { d_1: 'SEND-ALL', b_1: 'x', b_2: 'hola', d_3: 'send', b_3: '   ' }, finalizeMessage);
  const by = Object.fromEntries(r.decisions.map(d => [d.id, d]));
  assert.equal(by[1].status, 'skipped');
  assert.equal(by[2].status, 'skipped');
  assert.equal(by[3].status, 'skipped');
  assert.equal(by[3].reason, 'empty_message');
});

test('applyReview: normaliza saltos de línea de formulario y solo decide los borradores pendientes', () => {
  const r = V.applyReview([draft(1), draft(2, { status: 'blocked' })], { d_1: 'send', b_1: 'Linea 1\r\nLinea 2', d_2: 'send', b_2: 'intento de forzar un bloqueado' }, finalizeMessage);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].body_core, 'Linea 1\nLinea 2');
});

test('applyReview: ignora entradas que no son de este lote (ids ajenos) y texto gigante', () => {
  const r = V.applyReview([draft(1)], { d_1: 'send', b_1: 'a'.repeat(5000), d_99: 'send', b_99: 'x' }, finalizeMessage);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].status, 'skipped');
});

// ───────────── páginas de resultado y de mensaje ─────────────
test('renderResultPage resume lo enviado y escapa los nombres de ediciones rechazadas', () => {
  const html = V.renderResultPage({ approved: 7, skipped: 2, edited: 1, rejected_edits: [{ id: 5, name: '<b>X</b>', reason: 'edit_rejected:contains_url' }] }, 'TEST DATA');
  assert.match(html, /7/);
  assert.ok(!html.includes('<b>X</b>'));
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
});

test('renderMessagePage: página informativa (token inválido, vencido, ya enviado) sin reflejar datos sin escapar', () => {
  const html = V.renderMessagePage({ title: 'Link expired', message: '<img src=x onerror=1>' });
  assert.match(html, /Link expired/);
  assert.ok(!html.includes('<img src=x'));
});
