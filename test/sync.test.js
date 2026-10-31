const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sync');

const rec = (id, o = {}) => ({ id, name: '', email: '', phone: '', company: '', stage: '', updated_at: '2026-10-01T00:00:00Z', ...o });
const base = o => ({ name: '', email: '', phone: '', company: '', stage: '', ...o });

test('normalización: email, teléfono (misma regla que SQL) y similitud de nombres sin tildes ni mayúsculas', () => {
  assert.equal(S.normEmail('  Ana@Example.COM '), 'ana@example.com');
  assert.equal(S.normEmail('no-es-email'), '');
  assert.equal(S.normPhone('300 123 4567'), '+573001234567');
  assert.equal(S.normPhone('+1 (415) 555-0100'), '+14155550100');
  assert.equal(S.normPhone('12345'), '');
  assert.equal(S.nameSimilarity('Ana Pérez', 'ana perez'), 1);
  assert.equal(S.nameSimilarity('Ana Pérez', 'Luis Gómez'), 0);
  assert.ok(S.nameSimilarity('Ana María Pérez', 'Ana Pérez') >= 0.5);
});

test('registro sin email ni teléfono válido: inválido, no se crea en el otro lado', () => {
  const p = S.planSync({ crm: [rec('c1', { name: 'Sin datos', phone: '123' })], sheet: [] });
  assert.equal(p.creates.sheet.length, 0);
  assert.equal(p.issues[0].kind, 'invalid_record');
});

test('registro nuevo en un lado se crea en el otro, con vínculo y base', () => {
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'ANA@x.co', phone: '3001234567' })], sheet: [rec('r1', { name: 'Luis', email: 'luis@x.co' })] });
  assert.equal(p.creates.sheet.length, 1);
  assert.equal(p.creates.sheet[0].new_id, 'row-from-c1');
  assert.deepEqual(p.creates.sheet[0].fields.email, 'ana@x.co');
  assert.equal(p.creates.crm[0].new_id, 'crm-from-r1');
  assert.equal(p.new_links.length, 2);
});

test('mismo email en distinto formato se vincula y se rellena el campo vacío del otro lado, sin conflicto', () => {
  const p = S.planSync({
    crm: [rec('c1', { name: 'Ana Pérez', email: 'ana@x.co', phone: '', company: 'Acme' })],
    sheet: [rec('r1', { name: 'ana perez', email: 'ANA@X.CO', phone: '300 123 4567', company: '' })],
  });
  assert.equal(p.new_links.length, 1);
  assert.equal(p.new_links[0].how, 'email');
  assert.equal(p.conflicts.length, 0);
  assert.deepEqual(p.updates.crm[0].fields, { phone: '+573001234567' });
  assert.deepEqual(p.updates.sheet[0].fields, { company: 'Acme' });
  assert.equal(p.creates.crm.length + p.creates.sheet.length, 0);
});

test('vinculado por primera vez con valores distintos en ambos lados: conflicto, no se toca ninguno', () => {
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', stage: 'Won' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', stage: 'Lost' })] });
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0].field, 'stage');
  assert.equal(p.updates.crm.length + p.updates.sheet.length, 0);
});

test('cambio en un solo lado se copia al otro y actualiza la base', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co', stage: 'new' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', stage: 'Won' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', stage: 'New' })], links: [link] });
  assert.deepEqual(p.updates.sheet[0].fields, { stage: 'Won' });
  assert.equal(p.updates.crm.length, 0);
  assert.equal(p.base_updates[0].base.stage, 'won');
  // y al revés
  const q = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', stage: 'New' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', stage: 'Won' })], links: [link] });
  assert.deepEqual(q.updates.crm[0].fields, { stage: 'Won' });
});

test('los DOS lados cambiaron el mismo campo a valores distintos: conflicto con base y sin escrituras', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co', company: 'acme' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', company: 'Acme Inc' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', company: 'Acme LLC' })], links: [link] });
  assert.equal(p.conflicts.length, 1);
  assert.deepEqual([p.conflicts[0].crm_value, p.conflicts[0].sheet_value, p.conflicts[0].base_value], ['Acme Inc', 'Acme LLC', 'acme']);
  assert.equal(p.updates.crm.length + p.updates.sheet.length, 0);
});

test('los dos lados cambiaron al MISMO valor: no es conflicto, solo se actualiza la base', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co', stage: 'new' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', stage: 'Won' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', stage: 'won' })], links: [link] });
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.base_updates[0].base.stage, 'won');
});

test('un campo vaciado en un lado NO borra el valor del otro: se reporta', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co', company: 'acme' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co', company: '' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co', company: 'Acme' })], links: [link] });
  assert.equal(p.updates.crm.length + p.updates.sheet.length, 0);
  assert.equal(p.issues.find(i => i.kind === 'blank_ignored').detail.field, 'company');
});

test('borrado en un lado: no se propaga ni se recrea; el vínculo queda huérfano y se reporta', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co' })], sheet: [], links: [link] });
  assert.equal(p.creates.sheet.length, 0);
  assert.equal(p.issues[0].kind, 'orphan_link');
  assert.equal(p.issues[0].detail.missing, 'sheet');
});

test('duplicados dentro de un lado: mismo email se marca (el vinculado es el canónico); nunca se borra', () => {
  const link = { link_id: 1, crm_id: 'c2', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co' }) };
  const p = S.planSync({
    crm: [rec('c1', { name: 'Ana', email: 'A@x.co' }), rec('c2', { name: 'Ana', email: 'a@x.co' })],
    sheet: [rec('r1', { name: 'Ana', email: 'a@x.co' })], links: [link],
  });
  assert.deepEqual(p.duplicates, [{ side: 'crm', id: 'c1', canonical: 'c2', reason: 'same_email' }]);
  assert.equal(p.creates.sheet.length, 0);
});

test('mismo teléfono y nombres parecidos = duplicado; nombres distintos = revisión, NO se fusiona', () => {
  const similar = S.planSync({ crm: [rec('c1', { name: 'Ana Pérez', phone: '3001234567' }), rec('c2', { name: 'Ana Maria Pérez', phone: '+57 300 123 4567' })], sheet: [] });
  assert.equal(similar.duplicates.length, 1);
  assert.equal(similar.duplicates[0].reason, 'same_phone_similar_name');
  const family = S.planSync({ crm: [rec('c1', { name: 'Ana Pérez', phone: '3001234567' }), rec('c2', { name: 'Luis Gómez', phone: '3001234567' })], sheet: [] });
  assert.equal(family.duplicates.length, 0);
  assert.equal(family.issues[0].kind, 'possible_duplicate');
  assert.equal(family.creates.sheet.length, 2);
});

test('entre sistemas: mismo teléfono con nombre distinto se retiene (no se crea otro registro)', () => {
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana Pérez', phone: '3001234567' })], sheet: [rec('r1', { name: 'Recepción Clínica', phone: '3001234567' })] });
  assert.equal(p.creates.sheet.length + p.creates.crm.length, 0);
  assert.equal(p.new_links.length, 0);
  assert.equal(p.issues.some(i => i.kind === 'possible_duplicate'), true);
});

test('un registro nuevo con el email de uno ya vinculado a otro se retiene, no se duplica', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana', email: 'a@x.co' }) };
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana', email: 'a@x.co' })], sheet: [rec('r1', { name: 'Ana', email: 'a@x.co' }), rec('r2', { name: 'Ana otra', email: 'a@x.co' })], links: [link] });
  assert.equal(p.duplicates.length, 1);
  assert.equal(p.creates.crm.length, 0);
});

test('idempotencia: ya sincronizado y sin cambios = cero escrituras', () => {
  const link = { link_id: 1, crm_id: 'c1', sheet_id: 'r1', base: base({ name: 'ana pérez'.normalize('NFD').replace(/[̀-ͯ]/g, ''), email: 'a@x.co', phone: '+573001234567', company: 'acme', stage: 'new' }) };
  const crm = [rec('c1', { name: 'Ana Pérez', email: 'a@x.co', phone: '3001234567', company: 'Acme', stage: 'New' })];
  const sheet = [rec('r1', { name: 'ana perez', email: 'A@X.CO', phone: '+573001234567', company: 'ACME', stage: 'new' })];
  const p = S.planSync({ crm, sheet, links: [link] });
  assert.equal(p.writes, 0);
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.issues.length, 0);
});

test('convergencia: aplicar el plan y volver a planificar da cero escrituras', () => {
  const crm = [rec('c1', { name: 'Ana', email: 'a@x.co', phone: '3001234567' })];
  const sheet = [rec('r1', { name: 'Ana', email: 'a@x.co', company: 'Acme' }), rec('r2', { name: 'Luis', email: 'l@x.co' })];
  const p1 = S.planSync({ crm, sheet });
  // simula la aplicación del plan
  for (const u of p1.updates.crm) Object.assign(crm.find(r => r.id === u.id), u.fields);
  for (const u of p1.updates.sheet) Object.assign(sheet.find(r => r.id === u.id), u.fields);
  for (const c of p1.creates.crm) crm.push(rec(c.new_id, c.fields));
  for (const c of p1.creates.sheet) sheet.push(rec(c.new_id, c.fields));
  const links = p1.new_links.map((l, i) => ({ link_id: i + 1, ...l }));
  const p2 = S.planSync({ crm, sheet, links });
  assert.equal(p2.writes, 0, JSON.stringify(p2.stats));
  assert.equal(p2.conflicts.length, 0);
});

test('resolveChoice: crm/hoja copian el valor elegido; pendiente (o algo raro) no toca nada', () => {
  const c = { field: 'email', crm_value: 'New@X.co', sheet_value: 'old@x.co' };
  assert.deepEqual(S.resolveChoice(c, 'crm'), { action: 'copy', write_to: 'sheet', value: 'new@x.co', base: 'new@x.co' });
  assert.equal(S.resolveChoice(c, 'sheet').write_to, 'crm');
  assert.equal(S.resolveChoice(c, 'pending').action, 'none');
  assert.equal(S.resolveChoice(c, undefined).action, 'none');
});

test('buildNotice: escapa HTML de los datos y solo lista lo nuevo', () => {
  const stats = { created_in_crm: 1, created_in_sheet: 0, updated_in_crm: 0, updated_in_sheet: 2, duplicates_marked: 0 };
  const n = S.buildNotice({ stats, newConflicts: [{ field: 'company', crm_id: 'c1', sheet_id: 'r1', crm_value: '<b>Acme</b>', sheet_value: 'Acme' }], newIssues: [], reviewLink: 'http://x/y?a=1&b=2', dataLabel: 'TEST' });
  assert.ok(!n.html.includes('<b>Acme</b>'));
  assert.ok(n.html.includes('&lt;b&gt;Acme&lt;/b&gt;'));
  assert.ok(n.text.includes('http://x/y?a=1&b=2'));
});

test('cada incidencia aparece una sola vez (la misma pareja se ve desde ambos lados)', () => {
  const p = S.planSync({ crm: [rec('c1', { name: 'Ana Pérez', phone: '3001234567' })], sheet: [rec('r1', { name: 'Recepción Clínica', phone: '3001234567' })] });
  const keys = p.issues.map(i => i.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 1);
});
