const { Workflow, embed, uid, code, ifBool, ifEquals, logBranch, pg, respond } = require('../foundation');
const { REM } = require('./reminders-config');

const WF = 'reminders-staff';
const col = n => n * 240;

const LOAD_SQL = `SELECT (SELECT to_jsonb(a) FROM appt_appointments a WHERE a.appointment_id = $1) AS appointment`;

// Bloqueo optimista por versión: si otro cambio ocurrió entre la lectura y la escritura no se actualiza nada. Cancelar libera el horario.
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
u AS (
  UPDATE appt_appointments a SET
    status = COALESCE(d.j->'set'->>'status', a.status),
    checked_in_at = COALESCE((d.j->'set'->>'checked_in_at')::timestamptz, a.checked_in_at),
    no_show_at = COALESCE((d.j->'set'->>'no_show_at')::timestamptz, a.no_show_at),
    version = a.version + 1, updated_at = now()
  FROM d WHERE a.appointment_id = d.j->>'appointment_id' AND a.version = (d.j->>'version')::integer
  RETURNING a.appointment_id, a.status
),
f AS (UPDATE appt_slots SET status = 'free', appointment_id = NULL
      WHERE appointment_id = (SELECT j->>'appointment_id' FROM d) AND EXISTS (SELECT 1 FROM u WHERE status = 'cancelled') RETURNING slot_id),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail)
      SELECT appointment_id, (SELECT j->>'event' FROM d), (SELECT j->>'by' FROM d), COALESCE((SELECT j->'set' FROM d), '{}'::jsonb) FROM u RETURNING id)
SELECT (SELECT count(*) FROM u) AS updated, (SELECT count(*) FROM e) AS events, (SELECT count(*) FROM f) AS freed`;

module.exports = function remindersStaff() {
  const w = Workflow('reminderstaff0001', 'Reminders · Staff Update (Auditable)');

  w.add('Update Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'appt-update', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'El personal registra qué pasó con una cita: {appointment_id, action: check_in | attended | cancel | no_show, by}. Un check-in evita que se marque no-show. Protegido por x-reminders-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500], { mode: 'raw', jsonOutput: JSON.stringify({ config: REM }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Update', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: ['normalizeStaff'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeStaff(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-reminders-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { update: n.update, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, acción permitida y quién la hace. "now" solo en mock.' })
   .add('Valid Update?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 780], 400, '{ status: "rejected", errors: $json.validation.errors }');

  pg(w, 'Load Appointment', [col(4), 500], LOAD_SQL, '[$json.update.appointment_id]', { alwaysOutputData: true, notes: 'La cita actual, con su versión.' });
  w.add('Apply Update', 'n8n-nodes-base.code', 2, [col(5), 500], code(embed(
    [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: ['applyStaffUpdate'] }],
    `const s = $('Normalize Update').item.json;
const r = $input.item.json;
const now = s.update.now || new Date().toISOString();
const result = applyStaffUpdate(r.appointment, s.update, now);
return { json: { ...s, appointment_row: r.appointment, now, result } };`)),
    { notes: 'DETERMINÍSTICO: repetir una acción no cambia nada; un no-show equivocado se corrige marcándolo como asistido; una cita cerrada no se toca; cancelar libera el horario.' })
   .add('Updatable?', 'n8n-nodes-base.if', 2.2, [col(6), 500], ifBool('={{ $json.result.ok }}'))
   .add('Not Found?', 'n8n-nodes-base.if', 2.2, [col(7), 800], ifEquals('={{ $json.result.error }}', 'appointment_not_found'))
   .add('Recorded?', 'n8n-nodes-base.if', 2.2, [col(7), 500], ifEquals('={{ $json.result.outcome }}', 'recorded'));
  respond(w, 'Respond 404', [col(8), 900], 404, '{ status: "error", error: $json.result.error, appointment_id: $json.update.appointment_id }');
  respond(w, 'Respond 409', [col(8), 1060], 409, '{ status: "error", error: $json.result.error, appointment_id: $json.update.appointment_id }');
  respond(w, 'Respond Already Recorded', [col(8), 640], 200, '{ status: "already_recorded", appointment_id: $json.update.appointment_id, action: $json.update.action }');

  pg(w, 'Persist Update', [col(8), 400], PERSIST_SQL,
    '[JSON.stringify({ appointment_id: $json.update.appointment_id, version: $json.appointment_row.version, event: $json.result.event, by: $json.update.by, set: $json.result.set })]',
    { notes: 'Cambio + evento de auditoría (quién y cuándo) + horario liberado si se cancela, en UNA sentencia, con bloqueo optimista por versión.' });
  w.add('Update Persisted', 'n8n-nodes-base.code', 2, [col(9), 400], code(
    `const s = $('Apply Update').item.json;
const r = $input.item.json;
if (Number(r.updated) !== 1 || Number(r.events) !== 1) throw new Error('Update of appointment ' + s.update.appointment_id + ' (' + s.update.action + ') wrote ' + r.updated + ' rows: the appointment changed in between (concurrent_update). Nothing was applied.');
return { json: s };`));
  respond(w, 'Respond Recorded', [col(10), 400], 200, '{ status: "recorded", appointment_id: $json.update.appointment_id, action: $json.update.action, set: $json.result.set }');

  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.update.appointment_id', ...o });
  L('Normalize Update', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Apply Update', { step: 'update_decided', status: "$json.result.ok ? 'ok' : 'failed'", error: "$json.result.ok ? '' : $json.result.error", detail: '({ action: $json.update.action, by: $json.update.by, outcome: $json.result.outcome || null, set: $json.result.set || null })' });
  L('Update Persisted', { step: 'completed', detail: '({ action: $json.update.action, set: $json.result.set })' });

  w.note('## Reminders · Staff Update\nCheck-in, attended, cancel or manual no-show. A check-in stops the no-show sweep; a wrong no-show can be corrected; cancelling frees the slot. Every change records who made it.', [col(0) - 20, -150], col(9), 110);

  w.link('Update Webhook', 'Config').link('Config', 'Normalize Update').link('Normalize Update', 'Valid Update?')
   .link('Valid Update?', 'Load Appointment', 0).link('Valid Update?', 'Respond 400', 1)
   .link('Load Appointment', 'Apply Update').link('Apply Update', 'Updatable?')
   .link('Updatable?', 'Recorded?', 0).link('Updatable?', 'Not Found?', 1)
   .link('Not Found?', 'Respond 404', 0).link('Not Found?', 'Respond 409', 1)
   .link('Recorded?', 'Persist Update', 0).link('Recorded?', 'Respond Already Recorded', 1)
   .link('Persist Update', 'Update Persisted').link('Update Persisted', 'Respond Recorded');

  return { file: 'reminders-staff.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
