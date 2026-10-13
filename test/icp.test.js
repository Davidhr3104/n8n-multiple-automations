const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreByRules } = require('../lib/rules');
const { enrichLead } = require('../lib/enrich');
const { adaptPayload } = require('../lib/adapt');

const icp = { industries: ['saas', 'legal'], excludedIndustries: ['gambling'], minCompanySize: 10, minBudgetUsd: 1000, countries: ['US', 'CO'] };

test('ICP: industria objetivo suma y se explica; industria excluida resta pero nunca bajo 0', () => {
  const hit = scoreByRules({ email: 'a@gmail.com', industry: 'SaaS' }, { icp });
  assert.equal(hit.rule_score, 10);
  assert.ok(hit.evidence.some(e => e.rule === 'industry_match'));
  const miss = scoreByRules({ email: 'a@gmail.com', industry: 'Gambling' }, { icp });
  assert.equal(miss.rule_score, 0);
  assert.ok(miss.evidence.some(e => e.rule === 'excluded_industry' && e.points < 0));
});

test('ICP: países vienen de icp.countries y mínimos se reportan sin puntos', () => {
  const r = scoreByRules({ email: 'a@acme.com', country: 'CO', company_size: 3, budget_usd: 200 }, { icp });
  assert.ok(r.evidence.some(e => e.rule === 'target_country'));
  assert.ok(r.evidence.some(e => e.rule === 'below_icp_min_size' && e.points === 0));
  assert.ok(r.evidence.some(e => e.rule === 'below_icp_min_budget' && e.points === 0));
});

test('ICP: tamaño o presupuesto ausentes (null/undefined) NO cuentan como "bajo el mínimo"', () => {
  for (const lead of [{ email: 'a@acme.com' }, { email: 'a@acme.com', company_size: null, budget_usd: null }]) {
    const r = scoreByRules(lead, { icp });
    assert.ok(!r.evidence.some(e => e.rule.startsWith('below_icp')), JSON.stringify(r.evidence));
  }
});

test('enrich: dominio, empresa y país deducidos solo si faltan', () => {
  const e = enrichLead({ email: 'ana@acme-corp.com.mx', phone: '+52 55 1234', company: null, country: null });
  assert.equal(e.enrichment.domain, 'acme-corp.com.mx');
  assert.equal(e.company, 'Acme Corp');
  assert.equal(e.country, 'MX');
  assert.deepEqual(e.enrichment.enriched_fields.sort(), ['company', 'country']);
  const kept = enrichLead({ email: 'ana@acme.com', company: 'Real Co', country: 'US' });
  assert.equal(kept.company, 'Real Co');
  assert.equal(kept.country, 'US');
  assert.deepEqual(kept.enrichment.enriched_fields, []);
});

test('enrich: correo gratuito no inventa empresa', () => {
  const e = enrichLead({ email: 'sam@gmail.com', company: null, country: null });
  assert.equal(e.company, null);
  assert.equal(e.enrichment.is_free_email, true);
});

test('adapt: formato Meta Lead Ads (field_data) se mapea a campos planos', () => {
  const out = adaptPayload({ field_data: [{ name: 'full_name', values: ['Ana P'] }, { name: 'email', values: ['ana@acme.com'] }, { name: 'phone_number', values: ['+57300'] }, { name: 'company_name', values: ['Acme'] }, { name: 'que_necesitas', values: ['Quiero una demo'] }] });
  assert.equal(out.name, 'Ana P');
  assert.equal(out.email, 'ana@acme.com');
  assert.equal(out.phone, '+57300');
  assert.equal(out.company, 'Acme');
  assert.equal(out.source, 'meta_ads');
  assert.match(out.message, /Quiero una demo/);
});

test('adapt: formato email (from/subject/body) y payload plano pasan correctamente', () => {
  const em = adaptPayload({ from: 'Luis <luis@pymeco.com>', subject: 'Cotizacion', body: 'Necesito precios' });
  assert.equal(em.email, 'luis@pymeco.com');
  assert.equal(em.name, 'Luis');
  assert.equal(em.source, 'email');
  assert.match(em.message, /Cotizacion/);
  const flat = { name: 'X', email: 'x@y.com', message: 'm' };
  assert.deepEqual(adaptPayload(flat), flat);
  assert.equal(adaptPayload(null), null);
});
