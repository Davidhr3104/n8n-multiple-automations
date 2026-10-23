const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/schedule');

const WIN = { startHour: 9, endHour: 19, weekdays: [1, 2, 3, 4, 5] };
const CFG = { defaultTimezone: 'America/Bogota' };

// Miércoles 14-oct-2026 15:00Z = Bogotá (UTC-5) 10:00 · Madrid (UTC+2) 17:00 · Tokio (UTC+9) 00:00 del jueves
const WED_15Z = '2026-10-14T15:00:00.000Z';

test('localParts: día ISO (1=lunes..7=domingo), hora y minuto en la zona del contacto', () => {
  assert.deepEqual(S.localParts(WED_15Z, 'America/Bogota'), { weekday: 3, hour: 10, minute: 0 });
  assert.deepEqual(S.localParts(WED_15Z, 'Asia/Tokyo'), { weekday: 4, hour: 0, minute: 0 });
  assert.equal(S.localParts('2026-10-18T15:00:00.000Z', 'America/Bogota').weekday, 7); // domingo
});

test('isWithinWindow: dentro de 09:00-19:00 en día laboral local; fuera por hora o por fin de semana', () => {
  assert.equal(S.isWithinWindow(WED_15Z, 'America/Bogota', WIN), true);
  assert.equal(S.isWithinWindow(WED_15Z, 'Europe/Madrid', WIN), true);   // 17:00 local
  assert.equal(S.isWithinWindow(WED_15Z, 'Asia/Tokyo', WIN), false);     // 00:00 local
  assert.equal(S.isWithinWindow('2026-10-14T14:00:00.000Z', 'America/Bogota', WIN), true);  // 09:00 exacto = dentro
  assert.equal(S.isWithinWindow('2026-10-15T00:00:00.000Z', 'America/Bogota', WIN), false); // 19:00 exacto = fuera
  assert.equal(S.isWithinWindow('2026-10-17T15:00:00.000Z', 'America/Bogota', WIN), false); // sábado
});

test('nextWindowOpen: si ya está abierta devuelve el mismo instante; si no, el próximo día laboral a las 09:00 locales', () => {
  assert.equal(S.nextWindowOpen(WED_15Z, 'America/Bogota', WIN), WED_15Z);
  // Viernes 16-oct 20:00 Bogotá (= sábado 01:00Z) -> lunes 19-oct 09:00 Bogotá (= 14:00Z)
  assert.equal(S.nextWindowOpen('2026-10-17T01:00:00.000Z', 'America/Bogota', WIN), '2026-10-19T14:00:00.000Z');
  // Miércoles 04:00 Bogotá (09:00Z) -> mismo día 09:00 Bogotá (14:00Z)
  assert.equal(S.nextWindowOpen('2026-10-14T09:00:00.000Z', 'America/Bogota', WIN), '2026-10-14T14:00:00.000Z');
  // Tokio miércoles 15:00Z = jueves 00:00 local -> jueves 09:00 local = miércoles 00:00Z... del jueves 15-oct 00:00Z
  assert.equal(S.nextWindowOpen(WED_15Z, 'Asia/Tokyo', WIN), '2026-10-15T00:00:00.000Z');
});

test('nextWindowOpen: sin días laborales posibles devuelve null en vez de ciclar', () => {
  assert.equal(S.nextWindowOpen(WED_15Z, 'America/Bogota', { startHour: 9, endHour: 19, weekdays: [] }), null);
});

test('inferTimezone: zona del contacto > prefijo telefónico > por defecto, siempre declarando la fuente', () => {
  assert.deepEqual(S.inferTimezone({ timezone: 'Europe/Madrid', phone: '+57 300 1112233' }, CFG), { tz: 'Europe/Madrid', source: 'contact' });
  assert.deepEqual(S.inferTimezone({ phone: '+57 300 111 0001' }, CFG), { tz: 'America/Bogota', source: 'phone' });
  assert.deepEqual(S.inferTimezone({ phone: '+52 55 1111 0002' }, CFG), { tz: 'America/Mexico_City', source: 'phone' });
  assert.deepEqual(S.inferTimezone({ phone: '+34 600 111 004' }, CFG), { tz: 'Europe/Madrid', source: 'phone' });
});

test('inferTimezone: zona inválida, teléfono ambiguo (+1) o ausente => zona por defecto marcada como "default"', () => {
  assert.deepEqual(S.inferTimezone({ timezone: 'Marte/Olimpo', phone: null }, CFG), { tz: 'America/Bogota', source: 'default' });
  assert.deepEqual(S.inferTimezone({ phone: '+1 415 555 0009' }, CFG), { tz: 'America/Bogota', source: 'default' });
  assert.deepEqual(S.inferTimezone({}, CFG), { tz: 'America/Bogota', source: 'default' });
});

test('describeLocal: día y hora local legibles', () => {
  assert.equal(S.describeLocal(WED_15Z, 'America/Bogota'), 'Wed 10:00');
  assert.equal(S.describeLocal(WED_15Z, 'Asia/Tokyo'), 'Thu 00:00');
  assert.equal(S.describeLocal('2026-10-19T14:00:00.000Z', 'America/Bogota'), 'Mon 09:00');
});

test('sendNote: dice si el mensaje sale ya o cuándo se libera, declarando si la zona es supuesta', () => {
  const win = WIN;
  assert.match(S.sendNote(WED_15Z, { tz: 'America/Bogota', source: 'phone' }, win), /^Sends right away/);
  assert.match(S.sendNote(WED_15Z, { tz: 'Asia/Tokyo', source: 'contact' }, win), /Held until Thu 09:00/);
  assert.match(S.sendNote(WED_15Z, { tz: 'America/Bogota', source: 'default' }, win), /assumed/i);
});

test('isValidTimezone', () => {
  assert.equal(S.isValidTimezone('America/Bogota'), true);
  assert.equal(S.isValidTimezone('Nope/Nada'), false);
  assert.equal(S.isValidTimezone(undefined), false);
});
