// CRM ↔ Sheets Sync: lógica 100 % determinística (sin IA). Planifica; no escribe nada.
// Reglas: nunca se borra ni se propaga un borrado; un cambio en un solo lado se copia; un cambio distinto en los DOS lados es un
// conflicto y no se toca ninguno; los casos dudosos (mismo teléfono, nombres distintos) se reportan y NO se fusionan.
const FIELDS = ['name', 'email', 'phone', 'company', 'stage'];

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function normEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

// Misma regla que norm_phone() en SQL: menos de 8 dígitos = no es un teléfono.
function normPhone(v, cc = '57') {
  const s = String(v ?? '').trim();
  const d = s.replace(/[^0-9]/g, '');
  if (d.length < 8) return '';
  if (s.startsWith('+') || d.length >= 11) return '+' + d;
  return '+' + cc + d;
}

// Similitud de nombres: Jaccard de palabras, ignorando mayúsculas y tildes. Vacío = 0.
function nameSimilarity(a, b) {
  const ta = new Set(fold(a).split(' ').filter(Boolean));
  const tb = new Set(fold(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Forma canónica para COMPARAR (nunca para mostrar): evita falsos conflictos por mayúsculas, espacios o formato de teléfono.
const canon = (field, v, cc) => field === 'email' ? normEmail(v) : field === 'phone' ? normPhone(v, cc) : fold(v);
// Forma para ESCRIBIR en el otro sistema.
const outValue = (field, v, cc) => field === 'email' ? normEmail(v) : field === 'phone' ? normPhone(v, cc) : String(v ?? '').replace(/\s+/g, ' ').trim();

const createdId = (side, fromId) => (side === 'crm' ? 'crm-from-' : 'row-from-') + fromId;

function planSync({ crm = [], sheet = [], links = [], defaultCountry = '57', nameThreshold = 0.5 } = {}) {
  const cc = defaultCountry;
  const plan = {
    creates: { crm: [], sheet: [] },
    updates: { crm: [], sheet: [] },
    new_links: [],
    base_updates: [],
    duplicates: [],
    conflicts: [],
    issues: [],
    changes: [],
    stats: {},
  };
  const seenKeys = new Set();
  // Una incidencia por clave: la misma pareja puede detectarse desde ambos lados.
  const issue = (kind, key, detail) => { if (seenKeys.has(key)) return; seenKeys.add(key); plan.issues.push({ kind, key, detail }); };
  const keyOf = (...p) => p.join(':');
  const pairKey = (kind, side, a, b) => keyOf(kind, side, ...[a, b].sort());

  const prep = (side, rows) => {
    const ok = [];
    for (const r of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const n = { ...r, id: String(r.id), _email: normEmail(r.email), _phone: normPhone(r.phone, cc) };
      if (!n._email && !n._phone) { issue('invalid_record', keyOf('invalid', side, n.id), { side, id: n.id, reason: 'no_valid_email_or_phone' }); continue; }
      ok.push(n);
    }
    return ok;
  };

  const linkedCrm = new Set(links.map(l => String(l.crm_id)));
  const linkedSheet = new Set(links.map(l => String(l.sheet_id)));

  // ── 1) Duplicados dentro de un mismo lado ──
  const dedupe = (side, rows, linkedSet) => {
    const parent = new Map(rows.map(r => [r.id, r.id]));
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const reason = new Map();
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a._email && a._email === b._email) { union(a.id, b.id); reason.set(b.id, 'same_email'); }
      else if (a._phone && a._phone === b._phone) {
        if (nameSimilarity(a.name, b.name) >= nameThreshold) { union(a.id, b.id); reason.set(b.id, 'same_phone_similar_name'); }
        else issue('possible_duplicate', pairKey('dup', side, a.id, b.id), { side, ids: [a.id, b.id], reason: 'same_phone_different_name' });
      }
    }
    const groups = new Map();
    for (const r of rows) { const g = find(r.id); groups.set(g, [...(groups.get(g) || []), r]); }
    const active = [];
    for (const members of groups.values()) {
      if (members.length === 1) { active.push(members[0]); continue; }
      const linked = members.filter(m => linkedSet.has(m.id));
      if (linked.length > 1) {
        issue('possible_duplicate', keyOf('dup-linked', side, ...members.map(m => m.id).sort()), { side, ids: members.map(m => m.id), reason: 'several_linked_records' });
        active.push(...members);
        continue;
      }
      const canonical = linked[0] || members[0];
      active.push(canonical);
      for (const m of members) if (m !== canonical) plan.duplicates.push({ side, id: m.id, canonical: canonical.id, reason: reason.get(m.id) || 'same_email' });
    }
    return active;
  };

  const crmA = dedupe('crm', prep('crm', crm), linkedCrm);
  const sheetA = dedupe('sheet', prep('sheet', sheet), linkedSheet);
  const crmById = new Map(crmA.map(r => [r.id, r]));
  const sheetById = new Map(sheetA.map(r => [r.id, r]));

  // ── 2) Pares ya vinculados: fusión de tres vías contra el último valor sincronizado ──
  const mergePair = (c, s, base, upd, linkRef) => {
    const newBase = { ...base };
    const toSheet = {}, toCrm = {};
    for (const f of FIELDS) {
      const cv = canon(f, c[f], cc), sv = canon(f, s[f], cc), bv = base[f] ?? '';
      if (cv === sv) { newBase[f] = cv; continue; }
      const crmChanged = cv !== bv, sheetChanged = sv !== bv;
      if (crmChanged && sheetChanged) {
        plan.conflicts.push({ crm_id: c.id, sheet_id: s.id, field: f, crm_value: String(c[f] ?? ''), sheet_value: String(s[f] ?? ''), base_value: bv, crm_updated_at: c.updated_at ?? null, sheet_updated_at: s.updated_at ?? null });
      } else if (crmChanged) {
        if (cv === '') issue('blank_ignored', keyOf('blank', linkRef, f, 'crm'), { field: f, crm_id: c.id, sheet_id: s.id, side: 'crm' });
        else { toSheet[f] = outValue(f, c[f], cc); newBase[f] = cv; }
      } else if (sheetChanged) {
        if (sv === '') issue('blank_ignored', keyOf('blank', linkRef, f, 'sheet'), { field: f, crm_id: c.id, sheet_id: s.id, side: 'sheet' });
        else { toCrm[f] = outValue(f, s[f], cc); newBase[f] = sv; }
      }
    }
    if (Object.keys(toSheet).length) {
      plan.updates.sheet.push({ id: s.id, fields: toSheet, expected_updated_at: s.updated_at ?? null });
      for (const [f, v] of Object.entries(toSheet)) plan.changes.push({ side: 'sheet', action: 'update', entity_id: s.id, field: f, old_value: String(s[f] ?? ''), new_value: v, source_id: c.id });
    }
    if (Object.keys(toCrm).length) {
      plan.updates.crm.push({ id: c.id, fields: toCrm, expected_updated_at: c.updated_at ?? null });
      for (const [f, v] of Object.entries(toCrm)) plan.changes.push({ side: 'crm', action: 'update', entity_id: c.id, field: f, old_value: String(c[f] ?? ''), new_value: v, source_id: s.id });
    }
    return newBase;
  };

  for (const l of [...links].sort((a, b) => Number(a.link_id) - Number(b.link_id))) {
    const c = crmById.get(String(l.crm_id)), s = sheetById.get(String(l.sheet_id));
    if (!c || !s) { issue('orphan_link', keyOf('orphan', l.link_id), { link_id: l.link_id, crm_id: l.crm_id, sheet_id: l.sheet_id, missing: !c && !s ? 'both' : !c ? 'crm' : 'sheet' }); continue; }
    const base = l.base || {};
    const newBase = mergePair(c, s, base, null, String(l.link_id));
    if (FIELDS.some(f => (newBase[f] ?? '') !== (base[f] ?? ''))) plan.base_updates.push({ link_id: l.link_id, base: newBase });
  }

  // ── 3) Registros sin vínculo: emparejar, retener o crear ──
  const freeCrm = crmA.filter(r => !linkedCrm.has(r.id));
  const freeSheet = sheetA.filter(r => !linkedSheet.has(r.id));
  const taken = new Set();
  const pairs = [];
  for (const c of freeCrm) {
    let m = c._email ? freeSheet.find(s => !taken.has(s.id) && s._email === c._email) : null;
    if (!m && c._phone) m = freeSheet.find(s => !taken.has(s.id) && s._phone === c._phone && nameSimilarity(c.name, s.name) >= nameThreshold);
    if (m) { taken.add(m.id); pairs.push([c, m]); }
  }
  const pairedCrm = new Set(pairs.map(p => p[0].id));
  for (const [c, s] of pairs) {
    const base = {};
    for (const f of FIELDS) { const cv = canon(f, c[f], cc), sv = canon(f, s[f], cc); base[f] = cv === sv ? cv : ''; }
    const nb = mergePair(c, s, base, null, `new:${c.id}:${s.id}`);
    plan.new_links.push({ crm_id: c.id, sheet_id: s.id, base: nb, how: c._email && c._email === s._email ? 'email' : 'phone_and_name' });
  }

  const heldCrm = new Set(), heldSheet = new Set();
  const hold = (c, s, reason) => { heldCrm.add(c.id); heldSheet.add(s.id); issue('possible_duplicate', pairKey('dup-x', 'crm-sheet', c.id, s.id), { crm_id: c.id, sheet_id: s.id, reason }); };
  const looksSame = (a, b) => (a._email && a._email === b._email) || (a._phone && a._phone === b._phone);
  for (const c of freeCrm) {
    if (pairedCrm.has(c.id)) continue;
    for (const s of sheetA) if (looksSame(c, s)) hold(c, s, c._email && c._email === s._email ? 'same_email_other_record_linked' : 'same_phone_different_name');
  }
  for (const s of freeSheet) {
    if (taken.has(s.id)) continue;
    for (const c of crmA) if (looksSame(c, s)) hold(c, s, c._email && c._email === s._email ? 'same_email_other_record_linked' : 'same_phone_different_name');
  }

  const fieldsOf = r => Object.fromEntries(FIELDS.map(f => [f, outValue(f, r[f], cc)]));
  const baseOf = r => Object.fromEntries(FIELDS.map(f => [f, canon(f, r[f], cc)]));
  for (const c of freeCrm) if (!pairedCrm.has(c.id) && !heldCrm.has(c.id)) {
    plan.creates.sheet.push({ new_id: createdId('sheet', c.id), from_id: c.id, fields: fieldsOf(c), base: baseOf(c) });
    plan.new_links.push({ crm_id: c.id, sheet_id: createdId('sheet', c.id), base: baseOf(c), how: 'created_in_sheet' });
  }
  for (const s of freeSheet) if (!taken.has(s.id) && !heldSheet.has(s.id)) {
    plan.creates.crm.push({ new_id: createdId('crm', s.id), from_id: s.id, fields: fieldsOf(s), base: baseOf(s) });
    plan.new_links.push({ crm_id: createdId('crm', s.id), sheet_id: s.id, base: baseOf(s), how: 'created_in_crm' });
  }

  for (const c of plan.creates.sheet) plan.changes.push({ side: 'sheet', action: 'create', entity_id: c.new_id, field: null, old_value: null, new_value: JSON.stringify(c.fields), source_id: c.from_id });
  for (const c of plan.creates.crm) plan.changes.push({ side: 'crm', action: 'create', entity_id: c.new_id, field: null, old_value: null, new_value: JSON.stringify(c.fields), source_id: c.from_id });
  for (const d of plan.duplicates) plan.changes.push({ side: d.side, action: 'mark_duplicate', entity_id: d.id, field: 'merged_into', old_value: null, new_value: d.canonical, source_id: d.reason });

  const n = k => plan.issues.filter(i => i.kind === k).length;
  plan.stats = {
    crm_records: crmA.length, sheet_records: sheetA.length, links: links.length,
    created_in_crm: plan.creates.crm.length, created_in_sheet: plan.creates.sheet.length,
    updated_in_crm: plan.updates.crm.length, updated_in_sheet: plan.updates.sheet.length,
    new_links: plan.new_links.length, duplicates_marked: plan.duplicates.length, conflicts: plan.conflicts.length,
    invalid: n('invalid_record'), possible_duplicates: n('possible_duplicate'), orphan_links: n('orphan_link'), blank_ignored: n('blank_ignored'),
  };
  plan.writes = plan.stats.created_in_crm + plan.stats.created_in_sheet + plan.stats.updated_in_crm + plan.stats.updated_in_sheet + plan.base_updates.length + plan.duplicates.length;
  return plan;
}

// Qué hacer con un conflicto según la decisión de la persona. 'pending' (o cualquier otra cosa) no toca nada: falla cerrado.
function resolveChoice(conflict, choice) {
  if (choice === 'crm') return { action: 'copy', write_to: 'sheet', value: outValue(conflict.field, conflict.crm_value), base: canon(conflict.field, conflict.crm_value) };
  if (choice === 'sheet') return { action: 'copy', write_to: 'crm', value: outValue(conflict.field, conflict.sheet_value), base: canon(conflict.field, conflict.sheet_value) };
  return { action: 'none' };
}

const FIELD_LABEL = { name: 'Name', email: 'Email', phone: 'Phone', company: 'Company', stage: 'Stage' };
const KIND_LABEL = { invalid_record: 'Invalid record (no valid email or phone)', possible_duplicate: 'Possible duplicate (not merged)', orphan_link: 'Linked record missing on one side (nothing deleted)', blank_ignored: 'Field cleared on one side (not copied)' };

function describeIssue(i) {
  const d = i.detail || {};
  if (i.kind === 'invalid_record') return `${d.side} ${d.id}: ${d.reason}`;
  if (i.kind === 'possible_duplicate') return d.side ? `${d.side} ${d.ids.join(' & ')}: ${d.reason}` : `crm ${d.crm_id} & sheet ${d.sheet_id}: ${d.reason}`;
  if (i.kind === 'orphan_link') return `link ${d.link_id}: missing on ${d.missing} (crm ${d.crm_id}, sheet ${d.sheet_id})`;
  return `${d.field} cleared on ${d.side} (crm ${d.crm_id}, sheet ${d.sheet_id})`;
}

// Email de aviso: solo lo NUEVO (incidencias y conflictos recién vistos). Texto plano + HTML escapado.
function buildNotice({ stats, newIssues = [], newConflicts = [], reviewLink = null, dataLabel = '' }) {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [dataLabel, '', `Sync run: ${stats.created_in_crm + stats.created_in_sheet} created, ${stats.updated_in_crm + stats.updated_in_sheet} updated, ${stats.duplicates_marked} duplicate(s) marked.`, ''];
  if (newConflicts.length) {
    lines.push(`${newConflicts.length} new conflict(s) - both systems changed the same field; nothing was overwritten:`);
    for (const c of newConflicts.slice(0, 20)) lines.push(`  - ${FIELD_LABEL[c.field] || c.field} (crm ${c.crm_id} / sheet ${c.sheet_id}): CRM "${c.crm_value}" vs Sheet "${c.sheet_value}"`);
    if (reviewLink) lines.push('', `Resolve them here: ${reviewLink}`);
    lines.push('');
  }
  if (newIssues.length) {
    lines.push(`${newIssues.length} new item(s) need a look:`);
    for (const i of newIssues.slice(0, 20)) lines.push(`  - ${KIND_LABEL[i.kind] || i.kind}: ${describeIssue(i)}`);
    lines.push('');
  }
  const html = `<p>${esc(dataLabel)}</p><p>Sync run: <b>${stats.created_in_crm + stats.created_in_sheet}</b> created, <b>${stats.updated_in_crm + stats.updated_in_sheet}</b> updated, <b>${stats.duplicates_marked}</b> duplicate(s) marked.</p>`
    + (newConflicts.length ? `<p><b>${newConflicts.length}</b> new conflict(s): both systems changed the same field and nothing was overwritten.</p><ul>${newConflicts.slice(0, 20).map(c => `<li>${esc(FIELD_LABEL[c.field] || c.field)}: CRM "${esc(c.crm_value)}" vs Sheet "${esc(c.sheet_value)}"</li>`).join('')}</ul>${reviewLink ? `<p><a href="${esc(reviewLink)}" style="display:inline-block;padding:12px 22px;background:#1e40af;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700">Resolve conflicts</a></p>` : ''}` : '')
    + (newIssues.length ? `<p><b>${newIssues.length}</b> new item(s) need a look:</p><ul>${newIssues.slice(0, 20).map(i => `<li>${esc(KIND_LABEL[i.kind] || i.kind)}: ${esc(describeIssue(i))}</li>`).join('')}</ul>` : '');
  return { text: lines.join('\n'), html };
}

module.exports = { FIELDS, FIELD_LABEL, normEmail, normPhone, nameSimilarity, canon, outValue, createdId, planSync, resolveChoice, buildNotice, describeIssue };
