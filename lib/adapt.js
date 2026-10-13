// Determinístico: adaptadores de entrada. Cada canal manda su forma; aquí se reduce al payload plano del Lead Intake.
// OJO: la forma de Meta (field_data) y la de email (from/subject/body) son supuestos SIN verificar contra los proveedores reales.
function first(v) { return Array.isArray(v) ? v[0] : v; }

function adaptPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;

  if (Array.isArray(body.field_data)) {
    const f = {};
    for (const item of body.field_data) if (item && typeof item.name === 'string') f[item.name.toLowerCase()] = first(item.values);
    const known = new Set(['full_name', 'name', 'email', 'phone_number', 'phone', 'company_name', 'company', 'country', 'industry']);
    const extra = Object.entries(f).filter(([k, v]) => !known.has(k) && v).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
    return {
      name: f.full_name || f.name || '',
      email: f.email || '',
      phone: f.phone_number || f.phone || undefined,
      company: f.company_name || f.company || undefined,
      country: f.country || undefined,
      industry: f.industry || undefined,
      source: body.source || 'meta_ads',
      message: extra.join('. '),
    };
  }

  if (typeof body.from === 'string' && typeof body.body === 'string') {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(body.from);
    return {
      name: m ? m[1].trim() : '',
      email: (m ? m[2] : body.from).trim(),
      source: body.source || 'email',
      message: [body.subject, body.body].filter(Boolean).join('\n\n'),
    };
  }

  return body;
}

module.exports = { adaptPayload };
