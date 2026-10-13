const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeRequest, parseClaudeResponse, mockAssessment } = require('../lib/ai');

const lead = { name: 'Ana', email: 'ana@acme.com', message: 'Queremos automatizar ventas, presupuesto aprobado para este trimestre.' };
const wrap = input => ({ content: [{ type: 'tool_use', name: 'record_assessment', input }], stop_reason: 'tool_use' });
const okInput = { fit_score: 80, intent: 'high', confidence: 0.9, summary: 'Interés claro', risk_flags: [], evidence: [{ quote: 'presupuesto aprobado', supports: 'tiene presupuesto' }] };

test('request fuerza tool_use y encierra el mensaje como dato no confiable', () => {
  const body = buildClaudeRequest(lead, { rule_score: 50, evidence: [] }, 'claude-sonnet-5-5');
  assert.equal(body.tool_choice.name, 'record_assessment');
  assert.match(JSON.stringify(body.messages), /<lead_message>/);
  assert.match(body.system, /untrusted/i);
});

test('respuesta válida con evidencia verificada', () => {
  const r = parseClaudeResponse(wrap(okInput), lead);
  assert.equal(r.ok, true);
  assert.equal(r.assessment.confidence, 0.9);
  assert.equal(r.assessment.verified_evidence.length, 1);
  assert.equal(r.assessment.unverified_evidence.length, 0);
});

test('cita inventada se descarta y baja la confianza', () => {
  const r = parseClaudeResponse(wrap({ ...okInput, evidence: [{ quote: 'cita que no existe', supports: 'x' }] }), lead);
  assert.equal(r.ok, true);
  assert.equal(r.assessment.verified_evidence.length, 0);
  assert.equal(r.assessment.unverified_evidence.length, 1);
  assert.ok(r.assessment.confidence <= 0.5);
});

test('flag desconocido se mapea a other', () => {
  const r = parseClaudeResponse(wrap({ ...okInput, risk_flags: ['inventado'] }), lead);
  assert.deepEqual(r.assessment.risk_flags, ['other']);
});

test('fuera de rango, sin tool_use o error HTTP => fallo explícito', () => {
  assert.equal(parseClaudeResponse(wrap({ ...okInput, fit_score: 150 }), lead).ok, false);
  assert.equal(parseClaudeResponse({ content: [{ type: 'text', text: 'hola' }] }, lead).ok, false);
  const e = parseClaudeResponse({ error: { message: 'invalid x-api-key' } }, lead);
  assert.equal(e.ok, false);
  assert.match(e.error, /invalid x-api-key/);
  assert.equal(parseClaudeResponse(undefined, lead).ok, false);
});

test('mock produce la misma forma y se identifica como mock', () => {
  const m = mockAssessment(lead, { rule_score: 60, evidence: [] });
  assert.equal(m.model, 'mock');
  assert.ok(m.fit_score >= 0 && m.fit_score <= 100);
  assert.ok(m.confidence >= 0 && m.confidence <= 1);
});
