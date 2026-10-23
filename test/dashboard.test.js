const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dashboard');

const metrics = (over = {}) => ({
  generated_at: '2026-10-23T18:00:00.000Z', days: 7,
  contacts: { total: 25, active: 8, completed: 5, opted_out: 2, not_interested: 1, booking_sent: 1, needs_review: 2, messaged: 16 },
  drafts: { total: 30, pending_review: 3, approved: 2, skipped: 4, blocked: 1, failed: 0, deferred: 2, sent: 18, edited: 3 },
  touches: [{ touch: 1, sent: 10 }, { touch: 2, sent: 6 }, { touch: 3, sent: 2 }],
  replies: { contacts_replied: 4, total: 5, by_label: [{ label: 'interested', n: 2 }, { label: 'unsubscribe', n: 1 }, { label: 'unclear', n: 1 }, { label: 'not_interested', n: 1 }] },
  failures: [{ step: 'ghl_custom_fields', n: 2 }],
  batches: [{ batch_id: 'rev_20261023_1', status: 'approved', size: 10, created_at: '2026-10-23T14:00:00.000Z', sent: 8, skipped: 2 }],
  ...over,
});

test('dashboard: muestra el rótulo de datos de prueba y los KPI principales', () => {
  const html = D.renderDashboard(metrics(), { dataLabel: 'TEST DATA' });
  assert.match(html, /TEST DATA/);
  assert.match(html, /Messages sent/i);
  assert.match(html, />18</);
  assert.match(html, /Reply rate/i);
});

test('dashboard: tasa de respuesta = contactos que respondieron / contactos contactados (4/16 = 25 %)', () => {
  assert.equal(D.pct(4, 16), '25%');
  assert.equal(D.pct(1, 3), '33%');
  assert.equal(D.pct(0, 0), '—');
  assert.match(D.renderDashboard(metrics(), {}), /25%/);
});

test('dashboard: sin datos no divide por cero ni muestra NaN', () => {
  const empty = metrics({ contacts: { total: 0, active: 0, completed: 0, opted_out: 0, not_interested: 0, booking_sent: 0, needs_review: 0, messaged: 0 },
    drafts: { total: 0, pending_review: 0, approved: 0, skipped: 0, blocked: 0, failed: 0, deferred: 0, sent: 0, edited: 0 },
    touches: [], replies: { contacts_replied: 0, total: 0, by_label: [] }, failures: [], batches: [] });
  const html = D.renderDashboard(empty, { dataLabel: 'TEST DATA' });
  assert.ok(!/NaN|undefined|Infinity/.test(html));
  assert.match(html, /No batches yet|nothing yet/i);
});

test('dashboard: los booking links NO se presentan como citas confirmadas', () => {
  const html = D.renderDashboard(metrics(), {});
  assert.match(html, /Booking links sent/i);
  assert.match(html, /not confirmed appointments/i);
  assert.ok(!/appointments booked/i.test(html));
});

test('dashboard: todo dato dinámico va escapado y el periodo activo se anuncia con aria-current', () => {
  const html = D.renderDashboard(metrics({ batches: [{ batch_id: '<img src=x onerror=1>', status: '<b>x</b>', size: 1, created_at: 'now', sent: 0, skipped: 0 }], failures: [{ step: '<script>1</script>', n: 1 }] }), { dataLabel: '<i>x</i>' });
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>1</script>') && !html.includes('<i>x</i>'));
  assert.match(html, /aria-current="page"[^>]*>7 days/);
  assert.match(html, /href="\?days=30"/);
});

test('dashboard: las gráficas tienen alternativa accesible (tablas con th) y no dependen solo del color', () => {
  const html = D.renderDashboard(metrics(), {});
  assert.match(html, /<th[^>]*scope="col"/);
  assert.match(html, /<caption/);
  assert.match(html, /18<\/td>|>18</);
});
