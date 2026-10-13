// Determinístico: valida y normaliza el payload del webhook. Sin IA.
function normalizeLead(raw, nowIso) {
  const errors = [];
  const warnings = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'body', message: 'payload must be a JSON object' }], warnings, lead: null, lead_id: null, received_at: nowIso };
  }

  const str = v => (typeof v === 'string' ? v.trim() : '');
  const lead = {
    name: str(raw.name),
    email: str(raw.email).toLowerCase(),
    phone: str(raw.phone) || null,
    company: str(raw.company) || null,
    country: str(raw.country).toUpperCase() || null,
    source: str(raw.source).toLowerCase() || null,
    industry: str(raw.industry).toLowerCase() || null,
    message: str(raw.message),
    company_size: null,
    budget_usd: null,
  };

  if (!lead.name) errors.push({ field: 'name', message: 'required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push({ field: 'email', message: 'invalid or missing email' });
  if (!lead.message) errors.push({ field: 'message', message: 'required' });

  for (const field of ['company_size', 'budget_usd']) {
    const v = raw[field];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) lead[field] = n;
    else warnings.push({ field, message: `ignored non-numeric value: ${JSON.stringify(v)}` });
  }

  if (lead.message.length > 4000) {
    lead.message = lead.message.slice(0, 4000);
    warnings.push({ field: 'message', message: 'truncated to 4000 chars' });
  }

  const emailHash = hash8(lead.email || JSON.stringify(raw));
  const lead_id = `lead_${Date.parse(nowIso).toString(36)}_${emailHash}`;

  return { ok: errors.length === 0, errors, warnings, lead, lead_id, received_at: nowIso };
}

// djb2 -> 8 hex chars. No criptográfico: solo un identificador estable.
function hash8(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

module.exports = { normalizeLead };
