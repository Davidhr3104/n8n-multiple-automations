const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLead } = require('../lib/normalize');

const NOW = '2026-10-13T10:00:00.000Z';
const good = { name: ' Ana Pérez ', email: ' ANA@Acme.com ', message: 'Necesitamos automatizar el onboarding de clientes.' };

test('normaliza email y nombre', () => {
  const r = normalizeLead(good, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.lead.email, 'ana@acme.com');
  assert.equal(r.lead.name, 'Ana Pérez');
  assert.match(r.lead_id, /^lead_[a-z0-9]+_[0-9a-f]{8}$/);
});

test('lead_id es determinístico para mismo email y timestamp', () => {
  assert.equal(normalizeLead(good, NOW).lead_id, normalizeLead(good, NOW).lead_id);
});

test('rechaza email inválido y campos faltantes con errores explícitos', () => {
  const r = normalizeLead({ name: '', email: 'no-es-email', message: '' }, NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['email', 'message', 'name']);
});

test('payload no-objeto es rechazado, no explota', () => {
  const r = normalizeLead(null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'body');
});

test('coerciona budget y company_size numéricos y avisa si son basura', () => {
  const r = normalizeLead({ ...good, budget_usd: '5000', company_size: 'muchos' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.lead.budget_usd, 5000);
  assert.equal(r.lead.company_size, null);
  assert.ok(r.warnings.some(w => w.field === 'company_size'));
});

test('trunca mensajes largos y deja warning', () => {
  const r = normalizeLead({ ...good, message: 'x'.repeat(5000) }, NOW);
  assert.equal(r.lead.message.length, 4000);
  assert.ok(r.warnings.some(w => w.field === 'message'));
});
