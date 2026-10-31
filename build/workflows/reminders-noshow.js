const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { REM } = require('./reminders-config');

const WF = 'reminders-noshow';
const col = n => n * 240;
const R = exports_ => [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: exports_ }];

// Citas activas ya empezadas, sin check-in (el código aplica la gracia y la ventana: el SQL solo acota).
const CANDIDATES_SQL = `SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('appointment_id', a.appointment_id, 'status', a.status, 'starts_at', a.starts_at, 'checked_in_at', a.checked_in_at)
  ORDER BY a.starts_at) FROM appt_appointments a
  WHERE a.status IN ('scheduled', 'confirmed') AND a.checked_in_at IS NULL AND a.starts_at <= $1::timestamptz AND a.starts_at >= $1::timestamptz - interval '72 hours'), '[]'::jsonb) AS rows`;

// Marca no-show SOLO si sigue activa y sin check-in en este mismo instante: si el personal hizo check-in entre la lectura y la escritura, no se toca.
const MARK_SQL = `WITH u AS (
  UPDATE appt_appointments SET status = 'no_show', no_show_at = $2::timestamptz, version = version + 1, updated_at = now()
  WHERE appointment_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND status IN ('scheduled', 'confirmed') AND checked_in_at IS NULL
  RETURNING appointment_id
),
e AS (INSERT INTO appt_events (appointment_id, event, actor, detail) SELECT appointment_id, 'no_show', 'system', '{"auto":true}'::jsonb FROM u RETURNING id)
SELECT (SELECT count(*) FROM u) AS marked`;

const FOLLOWUPS_SQL = `SELECT
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'appointment_id', a.appointment_id, 'status', a.status, 'starts_at', a.starts_at, 'no_show_at', a.no_show_at, 'service', a.service,
    'suppressed', EXISTS (SELECT 1 FROM suppression_list s WHERE s.key = lower(c.email) OR s.key = c.phone),
    'no_show_count', (SELECT count(*) FROM appt_appointments x WHERE x.contact_id = a.contact_id AND x.status = 'no_show' AND x.starts_at > $1::timestamptz - interval '90 days'),
    'contact', jsonb_build_object('contact_id', c.contact_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'timezone', c.timezone)
  ) ORDER BY a.no_show_at)
  FROM appt_appointments a JOIN appt_contacts c ON c.contact_id = a.contact_id
  WHERE a.status = 'no_show' AND a.no_show_at > $1::timestamptz - interval '48 hours'), '[]'::jsonb) AS rows,
  COALESCE((SELECT jsonb_agg(r.appointment_id || '|' || r.kind) FROM appt_reminders r WHERE r.kind IN ('noshow', 'staff_repeat')), '[]'::jsonb) AS sent`;

// Seguimiento enviado, omitido con motivo, y aviso a una persona: todo se registra DESPUÉS de enviarse (clave cita|tipo).
const RECORD_SQL = `WITH d AS (SELECT $1::jsonb AS j),
r AS (
  INSERT INTO appt_reminders (appointment_id, kind, status, reason, recipients, execution_id)
  SELECT x->>'appointment_id', x->>'kind', x->>'status', NULLIF(x->>'reason', ''), NULLIF(x->>'to', ''), d.j->>'execution_id'
  FROM d, jsonb_array_elements(d.j->'rows') x
  ON CONFLICT (appointment_id, kind) DO NOTHING
  RETURNING appointment_id
),
c AS (
  INSERT INTO appt_conversation (contact_id, awaiting, appointment_id, offered_slots, offer_slot_id, attempts, updated_at)
  SELECT x->>'contact_id', 'reminder', x->>'appointment_id', '[]'::jsonb, NULL, 0, now() FROM d, jsonb_array_elements(d.j->'conv') x
  ON CONFLICT (contact_id) DO UPDATE SET awaiting = 'reminder', appointment_id = EXCLUDED.appointment_id, offered_slots = '[]'::jsonb, offer_slot_id = NULL, attempts = 0, updated_at = now()
  RETURNING contact_id
),
m AS (
  INSERT INTO appt_messages (contact_id, direction, kind, body, status, appointment_id, execution_id)
  SELECT x->>'contact_id', 'out', 'noshow_followup', x->>'text', 'sent', x->>'appointment_id', d.j->>'execution_id'
  FROM d, jsonb_array_elements(d.j->'rows') x WHERE x->>'status' = 'sent' AND x->>'kind' = 'noshow'
  RETURNING id
)
SELECT (SELECT count(*) FROM r) AS recorded, (SELECT count(*) FROM c) AS conversations, (SELECT count(*) FROM m) AS messages`;

module.exports = function remindersNoShow() {
  const w = Workflow('remindernoshow01', 'Reminders · No-show Sweep (Auditable)');

  w.add('Every 15 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] } }, { notes: 'Cada 15 minutos.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'reminders-noshow-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/reminders-noshow-run con la cabecera x-reminders-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200], { mode: 'raw', jsonOutput: JSON.stringify({ config: REM }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
let now = new Date().toISOString();
if (isWebhook) {
  if (item.headers['x-reminders-token'] !== c.internalToken) errors.push('bad_token');
  const n = item.body && item.body.now;
  if (n !== undefined && n !== '') {
    if (!c.allowTimeOverride) errors.push('time_override_not_allowed');
    else if (typeof n !== 'string' || !Number.isFinite(Date.parse(n))) errors.push('now');
    else now = new Date(n).toISOString();
  }
}
return { json: { config: c, now, run_id: String($execution.id), validation: { ok: errors.length === 0, errors } } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 200], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 520], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`));

  // ── Etapa 1: marcar no-shows ──
  pg(w, 'Read Candidates', [col(4), 200], CANDIDATES_SQL, '[$json.now]', { alwaysOutputData: true, notes: 'Citas activas ya empezadas y sin check-in de las últimas 72 h.' });
  w.add('Plan No-shows', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(R(['noShowCandidates']),
    `const s = $('Prepare').item.json;
const rows = $input.item.json.rows;
const ids = noShowCandidates(rows, s.now, s.config).map(a => a.appointment_id);
return { json: { ...s, noshow_ids: ids } };`)),
    { notes: 'DETERMINÍSTICO: no-show = cita activa, sin check-in, con más de 15 min de gracia y dentro de las 48 h de seguimiento.' });
  pg(w, 'Mark No-shows', [col(6), 200], MARK_SQL, '[JSON.stringify($json.noshow_ids), $json.now]',
    { alwaysOutputData: true, notes: 'Marca no_show solo si la cita sigue activa y sin check-in en ese instante. Deja un evento de auditoría por cita.' });

  // ── Etapa 2: seguimiento una sola vez + aviso de reincidentes ──
  pg(w, 'Read Follow-ups', [col(7), 200], FOLLOWUPS_SQL, "[$('Prepare').item.json.now]", { alwaysOutputData: true, notes: 'No-shows de las últimas 48 h con su contacto, la lista de bajas, su historial de 90 días y lo ya enviado.' });
  w.add('Plan Follow-ups', 'n8n-nodes-base.code', 2, [col(8), 200], code(embed(R(['planNoShowFollowUps', 'staffRepeatAlert']),
    `const s = $('Plan No-shows').item.json;
const marked = Number($('Mark No-shows').item.json.marked);
const r = $input.item.json;
const plan = planNoShowFollowUps(r.rows, r.sent, s.now, s.config);
const staff = staffRepeatAlert(r.rows, r.sent, s.config);
return { json: { ...s, marked, plan, staff } };`)),
    { notes: 'DETERMINÍSTICO: un seguimiento por cita, solo una vez; respeta bajas, canal y el horario de envío. Los reincidentes (2 o más no-shows en 90 días) se señalan a una persona: no se bloquea ni se cobra nada.' })
   .add('Anything To Send?', 'n8n-nodes-base.if', 2.2, [col(9), 200], ifBool('={{ $json.plan.send.length > 0 || $json.staff !== null }}'))
   .add('Nothing To Send', 'n8n-nodes-base.code', 2, [col(10), 520], code(
    `const s = $input.item.json;
const rows = s.plan.skip.map(k => ({ appointment_id: k.appointment_id, kind: k.kind, status: 'skipped', reason: k.reason, contact_id: k.contact_id }));
return { json: { ...s, notices: [], rows, conv: [], failed: [], execution_id: String($execution.id) } };`),
    { notes: 'Sin mensajes que enviar ahora. Los omitidos (baja, sin canal, ventana cerrada) se registran igual con su motivo.' })
   .add('Expand Messages', 'n8n-nodes-base.code', 2, [col(10), 200], codeAll(
    `const s = $input.first().json;
const items = s.plan.send.map(m => ({ json: { from: s.config.fromEmail, to: m.to, phone: m.phone, text: m.text, appointment_id: m.appointment_id, kind: 'noshow', contact_id: m.contact_id, staff: false } }));
if (s.staff) items.push({ json: { from: s.config.fromEmail, to: s.config.ownerEmail, phone: '', text: s.staff.text, appointment_id: s.staff.appointment_ids.join(','), kind: 'staff_repeat', contact_id: '', staff: true, appointment_ids: s.staff.appointment_ids } });
return items;`))
   .add('Send Message (SMS mock)', 'n8n-nodes-base.emailSend', 2.1, [col(11), 200], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: "={{ $json.staff ? 'Repeat no-shows need a decision' : 'SMS · ' + ($json.phone || $json.to) }}",
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'En local el SMS es un correo a Mailpit. Un envío fallido NO se registra: se reintenta en la siguiente corrida.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(12), 200], codeAll(
    `const s = $('Plan Follow-ups').first().json;
const out = $('Expand Messages').all();
const notices = $input.all().map((r, i) => ({ ...out[i].json, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const rows = [];
for (const n of notices.filter(x => x.ok)) {
  if (n.staff) for (const id of n.appointment_ids) rows.push({ appointment_id: id, kind: 'staff_repeat', status: 'sent', to: n.to, contact_id: '' });
  else rows.push({ appointment_id: n.appointment_id, kind: 'noshow', status: 'sent', to: n.to, contact_id: n.contact_id, text: n.text });
}
for (const k of s.plan.skip) rows.push({ appointment_id: k.appointment_id, kind: k.kind, status: 'skipped', reason: k.reason, contact_id: k.contact_id });
const conv = notices.filter(n => n.ok && !n.staff).map(n => ({ contact_id: n.contact_id, appointment_id: n.appointment_id }));
return [{ json: { ...s, notices: notices.map(n => ({ to: n.to, kind: n.kind, ok: n.ok, error: n.error })), rows, conv, failed: notices.filter(n => !n.ok).map(n => ({ to: n.to, kind: n.kind, error: n.error })), execution_id: String($execution.id) } }];`),
    { notes: 'Cada mensaje cuenta solo si salió. La conversación del cliente queda "esperando respuesta" para que "2" le ofrezca horarios nuevos.' });
  pg(w, 'Record Follow-ups', [col(13), 200], RECORD_SQL, '[JSON.stringify({ rows: $json.rows, conv: $json.conv, execution_id: $json.execution_id })]',
    { alwaysOutputData: true, notes: 'Registra seguimientos enviados, omitidos con su motivo y el aviso a la persona responsable. Una sola sentencia.' });
  w.add('Sweep Result', 'n8n-nodes-base.code', 2, [col(14), 200], code(
    `let s;
try { s = $('Collect Sends').first().json; } catch (e) { s = $('Nothing To Send').first().json; }
const r = $input.item.json;
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, marked_no_show: s.marked, followups_sent: s.rows.filter(x => x.kind === 'noshow' && x.status === 'sent').length, staff_alerted: s.rows.some(x => x.kind === 'staff_repeat' && x.status === 'sent'), skipped: s.rows.filter(x => x.status === 'skipped').map(x => x.appointment_id + ':' + x.reason), deferred: s.plan.defer.map(x => x.appointment_id), recorded: Number(r.recorded), failed: s.failed } };`))
   .add('Assert Sweep', 'n8n-nodes-base.code', 2, [col(15), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('No-show sweep: ' + r.failed.length + ' message(s) failed and will be retried next run: ' + r.failed.map(f => f.kind + ' -> ' + f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'sweep_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Plan No-shows', { workflow: WF, step: 'noshows_planned', entity: '$json.run_id', detail: '({ ids: $json.noshow_ids })' });
  logBranch(w, 'Plan Follow-ups', { workflow: WF, step: 'followups_planned', entity: '$json.run_id', detail: '({ marked: $json.marked, send: $json.plan.send.map(s => s.appointment_id), defer: $json.plan.defer, skip: $json.plan.skip, staff: $json.staff ? $json.staff.appointment_ids : null })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'followups_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices })' });

  w.note('## Reminders · No-show Sweep\nEvery 15 minutes: after the grace period with no check-in, code marks the appointment as a no-show and the customer gets ONE follow-up offering a new time. Staff can correct a wrong no-show. Repeat no-shows are flagged to a person; nothing is blocked or charged automatically.', [col(0) - 20, -250], col(12), 110);

  w.link('Every 15 Minutes', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Candidates', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Candidates', 'Plan No-shows').link('Plan No-shows', 'Mark No-shows').link('Mark No-shows', 'Read Follow-ups')
   .link('Read Follow-ups', 'Plan Follow-ups').link('Plan Follow-ups', 'Anything To Send?')
   .link('Anything To Send?', 'Expand Messages', 0).link('Anything To Send?', 'Nothing To Send', 1)
   .link('Expand Messages', 'Send Message (SMS mock)').link('Send Message (SMS mock)', 'Collect Sends').link('Collect Sends', 'Record Follow-ups')
   .link('Nothing To Send', 'Record Follow-ups')
   .link('Record Follow-ups', 'Sweep Result').link('Sweep Result', 'Assert Sweep');

  return { file: 'reminders-noshow.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
