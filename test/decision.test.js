const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, applyHumanDecision } = require('../lib/decision');

const cfg = { confidenceThreshold: 0.7, hotScore: 75, warmScore: 50, highValueBudget: 10000 };
const ai = (o = {}) => ({ ok: true, assessment: { fit_score: 90, confidence: 0.9, risk_flags: [], ...o } });

test('score combinado 40% reglas / 60% IA y tier hot', () => {
  const d = decide({ rule_score: 80 }, ai({ fit_score: 90 }), { budget_usd: 500 }, cfg);
  assert.equal(d.final_score, 86);
  assert.equal(d.tier, 'hot');
  assert.equal(d.needs_human, false);
});

test('tiers warm y cold', () => {
  assert.equal(decide({ rule_score: 50 }, ai({ fit_score: 50 }), {}, cfg).tier, 'warm');
  assert.equal(decide({ rule_score: 10 }, ai({ fit_score: 20 }), {}, cfg).tier, 'cold');
});

test('baja confianza exige humano', () => {
  const d = decide({ rule_score: 80 }, ai({ confidence: 0.4 }), {}, cfg);
  assert.equal(d.needs_human, true);
  assert.ok(d.reasons.includes('low_confidence'));
});

test('risk flags exigen humano', () => {
  const d = decide({ rule_score: 80 }, ai({ risk_flags: ['prompt_injection_attempt'] }), {}, cfg);
  assert.ok(d.reasons.includes('risk_flags'));
});

test('hot con presupuesto alto exige sign-off', () => {
  const d = decide({ rule_score: 90 }, ai(), { budget_usd: 50000 }, cfg);
  assert.ok(d.reasons.includes('high_value_requires_signoff'));
});

test('fallo de IA nunca es silencioso: humano y razón ai_failed, score solo por reglas', () => {
  const d = decide({ rule_score: 70 }, { ok: false, error: 'timeout' }, {}, cfg);
  assert.equal(d.needs_human, true);
  assert.ok(d.reasons.includes('ai_failed'));
  assert.equal(d.final_score, 70);
  assert.equal(d.ai_error, 'timeout');
});

test('humano: solo approved===true aprueba; timeout o undefined falla cerrado', () => {
  assert.equal(applyHumanDecision({ approved: true }).status, 'approved_by_human');
  assert.equal(applyHumanDecision({ approved: false }).status, 'rejected_by_human');
  assert.equal(applyHumanDecision({}).status, 'no_human_response');
  assert.equal(applyHumanDecision(undefined).status, 'no_human_response');
});
