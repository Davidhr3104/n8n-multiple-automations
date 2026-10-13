// Determinístico: scoring por reglas explícitas contra el ICP configurable. Cada punto tiene evidencia.
const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com',
  'yahoo.es', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'msn.com',
]);

function scoreByRules(lead, cfg) {
  const icp = cfg.icp || {};
  const countries = icp.countries || cfg.targetCountries || [];
  const evidence = [];
  const add = (rule, points, detail) => evidence.push({ rule, points, detail });
  const domain = (lead.email || '').split('@')[1] || '';

  if (FREE_DOMAINS.has(domain)) add('free_email_domain', 0, `${domain} is a free email provider`);
  else if (domain) add('business_email_domain', 20, `${domain} looks like a business domain`);

  if (lead.company) add('company_provided', 10, `company: ${lead.company}`);

  const size = lead.company_size;
  if (size >= 200) add('company_size', 20, `${size} employees (>=200)`);
  else if (size >= 50) add('company_size', 15, `${size} employees (50-199)`);
  else if (size >= 10) add('company_size', 10, `${size} employees (10-49)`);
  else if (size >= 1) add('company_size', 5, `${size} employees (1-9)`);
  if (icp.minCompanySize && typeof size === 'number' && size < icp.minCompanySize) add('below_icp_min_size', 0, `${size} employees < ICP minimum ${icp.minCompanySize}`);

  const b = lead.budget_usd;
  if (b >= 10000) add('budget', 30, `budget $${b} (>=10000)`);
  else if (b >= 3000) add('budget', 20, `budget $${b} (3000-9999)`);
  else if (b >= 1000) add('budget', 10, `budget $${b} (1000-2999)`);
  else if (b > 0) add('budget', 3, `budget $${b} (<1000)`);
  if (icp.minBudgetUsd && typeof b === 'number' && b < icp.minBudgetUsd) add('below_icp_min_budget', 0, `budget $${b} < ICP minimum $${icp.minBudgetUsd}`);

  if (lead.phone) add('phone_provided', 5, 'phone number provided');

  if (lead.country && countries.includes(lead.country)) add('target_country', 10, `${lead.country} is a target market`);

  const industry = (lead.industry || '').toLowerCase();
  if (industry && (icp.industries || []).map(s => s.toLowerCase()).includes(industry)) add('industry_match', 10, `industry "${lead.industry}" is in the ICP`);
  if (industry && (icp.excludedIndustries || []).map(s => s.toLowerCase()).includes(industry)) add('excluded_industry', -30, `industry "${lead.industry}" is excluded by the ICP`);

  if (lead.source === 'referral') add('referral_source', 5, 'came via referral');

  const total = evidence.reduce((s, e) => s + e.points, 0);
  return { rule_score: Math.max(0, Math.min(100, total)), evidence };
}

module.exports = { scoreByRules };
