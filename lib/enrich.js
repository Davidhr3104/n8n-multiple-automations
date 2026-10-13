// Determinístico: enriquecimiento derivado (sin APIs externas). Solo rellena lo que falta y lo declara en enriched_fields.
// Para datos de terceros (Apollo, Clearbit...) este es el punto de enchufe: devolver la misma forma.
const FREE = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.es', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'msn.com']);
const TLD_COUNTRY = { co: 'CO', mx: 'MX', es: 'ES', uk: 'GB', ca: 'CA', ar: 'AR', cl: 'CL', pe: 'PE', us: 'US' };
const PHONE_COUNTRY = [['+57', 'CO'], ['+52', 'MX'], ['+34', 'ES'], ['+44', 'GB'], ['+54', 'AR'], ['+56', 'CL'], ['+51', 'PE'], ['+1', 'US']];
const SECOND_LEVEL = new Set(['com', 'org', 'net', 'co', 'gob', 'edu']);

function enrichLead(lead) {
  const out = { ...lead };
  const domain = (lead.email || '').split('@')[1] || '';
  const is_free_email = FREE.has(domain);
  const enriched_fields = [];

  if (!out.company && domain && !is_free_email) {
    const parts = domain.split('.');
    while (parts.length > 1 && (SECOND_LEVEL.has(parts[parts.length - 1]) || parts[parts.length - 1].length === 2) && parts.length > 2) parts.pop();
    const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    out.company = label.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    enriched_fields.push('company');
  }

  if (!out.country) {
    const tld = domain.split('.').pop();
    const phone = (lead.phone || '').replace(/\s+/g, '');
    const byTld = !is_free_email && TLD_COUNTRY[tld];
    const byPhone = (PHONE_COUNTRY.find(([p]) => phone.startsWith(p)) || [])[1];
    const guess = byTld || byPhone;
    if (guess) { out.country = guess; enriched_fields.push('country'); }
  }

  out.enrichment = { source: 'derived', domain, is_free_email, enriched_fields };
  return out;
}

module.exports = { enrichLead };
