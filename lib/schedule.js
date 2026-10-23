// Horario de envío: determinístico. Un mensaje comercial solo sale en horario laboral LOCAL del contacto.
// Si no sabemos su zona horaria, usamos la de por defecto y lo declaramos (source: 'default'): nunca se asume en silencio.
const TZ_BY_CALLING_CODE = [
  ['+57', 'America/Bogota'], ['+52', 'America/Mexico_City'], ['+34', 'Europe/Madrid'], ['+44', 'Europe/London'],
  ['+54', 'America/Argentina/Buenos_Aires'], ['+56', 'America/Santiago'], ['+51', 'America/Lima'], ['+593', 'America/Guayaquil'],
  // '+1' se omite a propósito: abarca varias zonas horarias; sin código de área fiable caemos a la zona por defecto.
];

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Día ISO (1=lunes..7=domingo), hora y minuto del instante dado en la zona indicada.
function localParts(nowIso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(nowIso));
  const get = type => parts.find(p => p.type === type).value;
  return { weekday: WEEKDAYS[get('weekday')], hour: Number(get('hour')), minute: Number(get('minute')) };
}

// startHour incluida, endHour excluida.
function isWithinWindow(nowIso, tz, window) {
  const { weekday, hour } = localParts(nowIso, tz);
  return window.weekdays.includes(weekday) && hour >= window.startHour && hour < window.endHour;
}

// Primer instante (resolución de 15 min) en que la ventana está abierta; el mismo instante si ya lo está.
// null si en 8 días no abre nunca (configuración sin días laborales).
function nextWindowOpen(nowIso, tz, window) {
  if (!window.weekdays.length) return null;
  const STEP = 15 * 60 * 1000;
  let t = Math.ceil(Date.parse(nowIso) / STEP) * STEP;
  if (isWithinWindow(nowIso, tz, window)) return new Date(Date.parse(nowIso)).toISOString();
  for (let i = 0; i < 8 * 24 * 4; i++, t += STEP) {
    const iso = new Date(t).toISOString();
    if (isWithinWindow(iso, tz, window)) return iso;
  }
  return null;
}

function inferTimezone(contact, cfg) {
  if (isValidTimezone(contact.timezone)) return { tz: contact.timezone, source: 'contact' };
  const phone = typeof contact.phone === 'string' ? contact.phone.replace(/[^\d+]/g, '') : '';
  if (phone.startsWith('+')) {
    const hit = [...TZ_BY_CALLING_CODE].sort((a, b) => b[0].length - a[0].length).find(([code]) => phone.startsWith(code));
    if (hit) return { tz: hit[1], source: 'phone' };
  }
  return { tz: cfg.defaultTimezone, source: 'default' };
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = n => String(n).padStart(2, '0');

// "Thu 09:00" en la zona del contacto.
function describeLocal(iso, tz) {
  const p = localParts(iso, tz);
  return `${DAY_NAMES[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

// Texto para el dueño: ¿sale ya o se retiene? Si la zona es la de por defecto, lo dice (es una suposición).
function sendNote(nowIso, tzInfo, window) {
  const range = `${pad(window.startHour)}:00-${pad(window.endHour)}:00 local, ${tzInfo.tz}`;
  const assumed = tzInfo.source === 'default' ? ' Time zone assumed (not known for this contact).' : '';
  if (isWithinWindow(nowIso, tzInfo.tz, window)) return `Sends right away (sending hours ${range}).${assumed}`;
  const next = nextWindowOpen(nowIso, tzInfo.tz, window);
  return next ? `Held until ${describeLocal(next, tzInfo.tz)} local (sending hours ${range}).${assumed}` : `No sending hours are configured.${assumed}`;
}

module.exports = { isValidTimezone, localParts, isWithinWindow, nextWindowOpen, inferTimezone, describeLocal, sendNote };
