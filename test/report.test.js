const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportRequest, parseReportResponse, mockReport, renderReportHtml } = require('../lib/report');
const { buildClaudeRequest, parseClaudeResponse, mockAssessment } = require('../lib/ai');

const metrics = {
  period: { from: '2026-10-06T00:00:00Z', to: '2026-10-13T00:00:00Z' },
  totals: { leads: 10, processed: 8, rejected_invalid: 1, duplicates: 1, hot: 3, warm: 3, cold: 2, human_reviewed: 4, approved_by_human: 2, rejected_by_human: 1, crm_failed: 1, avg_score: 61.5 },
  by_channel: [{ channel: 'meta_ads', leads: 6, hot: 2 }, { channel: 'form', leads: 4, hot: 1 }],
  by_rep: [{ rep: 'rep1@x.com', assigned: 2 }],
  top_leads: [{ name: 'Ana <script>alert(1)</script>', company: 'Acme', score: 95, tier: 'hot', source: 'meta_ads' }],
  failures: [{ step: 'crm_sync', count: 1 }],
};
const wrap = input => ({ content: [{ type: 'tool_use', name: 'record_report', input }] });

test('mockReport es determinístico y usa solo cifras de metrics', () => {
  const r = mockReport(metrics);
  assert.equal(r.model, 'mock');
  assert.match(r.summary, /10/);
  assert.ok(r.highlights.length > 0);
  assert.deepEqual(mockReport(metrics), r);
});

test('buildReportRequest fuerza tool_use y pide no inventar cifras', () => {
  const b = buildReportRequest(metrics, 'claude-sonnet-5-5');
  assert.equal(b.tool_choice.name, 'record_report');
  assert.match(b.system, /do not invent|only the numbers/i);
  assert.match(JSON.stringify(b.messages), /meta_ads/);
});

test('parseReportResponse valida forma y falla explícito', () => {
  const ok = parseReportResponse(wrap({ headline: 'H', summary: 'S', highlights: ['a'], risks: [], recommendations: ['r'] }));
  assert.equal(ok.ok, true);
  assert.equal(parseReportResponse(wrap({ headline: 'H' })).ok, false);
  assert.equal(parseReportResponse({ error: { message: 'x' } }).ok, false);
  assert.equal(parseReportResponse(undefined).ok, false);
});

test('renderReportHtml escapa datos de leads (sin HTML inyectado) e incluye métricas', () => {
  const html = renderReportHtml(metrics, mockReport(metrics));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /meta_ads/);
  assert.match(html, /61\.5/);
});

test('ai: el borrador del primer mensaje se valida (largo) y el mock lo incluye', () => {
  const lead = { name: 'Ana', email: 'ana@acme.com', message: 'Queremos una demo urgente' };
  const base = { fit_score: 80, intent: 'high', confidence: 0.9, summary: 's', risk_flags: [], evidence: [{ quote: 'demo urgente', supports: 'x' }] };
  const wrapA = input => ({ content: [{ type: 'tool_use', name: 'record_assessment', input }] });
  assert.equal(parseClaudeResponse(wrapA({ ...base, draft_message: 'Hola Ana, {REP_NAME}' }), lead).assessment.draft_message, 'Hola Ana, {REP_NAME}');
  assert.equal(parseClaudeResponse(wrapA({ ...base, draft_message: 'x'.repeat(800) }), lead).assessment.draft_message, null);
  assert.equal(parseClaudeResponse(wrapA(base), lead).assessment.draft_message, null);
  assert.match(mockAssessment(lead, { rule_score: 50, evidence: [] }).draft_message, /\{REP_NAME\}/);
});

test('ai: el borrador mock sigue el idioma del lead y no confunde palabras inglesas', () => {
  const es = mockAssessment({ name: 'Ana', message: 'Necesitamos automatizar la facturacion' }, { rule_score: 1, evidence: [] }).draft_message;
  assert.match(es, /^Hola Ana/);
  const en = mockAssessment({ name: 'Bob', message: 'We have synonyms and nonsense pronouns in our request' }, { rule_score: 1, evidence: [] }).draft_message;
  assert.match(en, /^Hi Bob/);
});

test('ai: el código fuente no contiene caracteres de control (p.ej. backspace por un \\b mal escapado)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(src));
});

test('ai: el ICP entra al prompt como contexto confiable', () => {
  const body = buildClaudeRequest({ message: 'm' }, { rule_score: 1, evidence: [] }, 'x', { industries: ['saas'], minBudgetUsd: 1000 });
  assert.match(JSON.stringify(body.messages), /icp/i);
  assert.match(JSON.stringify(body.messages), /saas/);
});
