const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreByRules } = require('../lib/rules');

const cfg = { targetCountries: ['US', 'CO'] };

test('lead fuerte suma 100 con evidencia por regla', () => {
  const r = scoreByRules({ email: 'a@acme.com', company: 'Acme', company_size: 300, budget_usd: 20000, phone: '+1', country: 'US', source: 'referral' }, cfg);
  assert.equal(r.rule_score, 100);
  assert.ok(r.evidence.every(e => e.rule && typeof e.points === 'number' && e.detail));
});

test('email gratuito no suma y queda marcado', () => {
  const r = scoreByRules({ email: 'a@gmail.com' }, cfg);
  assert.equal(r.rule_score, 0);
  assert.ok(r.evidence.some(e => e.rule === 'free_email_domain' && e.points === 0));
});

test('budget por tramos', () => {
  const pts = b => scoreByRules({ email: 'a@gmail.com', budget_usd: b }, cfg).rule_score;
  assert.equal(pts(500), 3);
  assert.equal(pts(1500), 10);
  assert.equal(pts(5000), 20);
  assert.equal(pts(10000), 30);
});

test('nunca excede 100 ni baja de 0', () => {
  const r = scoreByRules({ email: 'a@acme.com', company: 'x', company_size: 9999, budget_usd: 1e9, phone: '1', country: 'US', source: 'referral' }, cfg);
  assert.ok(r.rule_score <= 100 && r.rule_score >= 0);
});
