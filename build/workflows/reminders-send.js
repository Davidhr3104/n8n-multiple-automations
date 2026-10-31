const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { REM } = require('./reminders-config');

const WF = 'reminders-send';
const col = n => n * 240;

// Citas activas de las próximas 49 h con su contacto, si está en la lista de bajas, y los recordatorios ya registrados (enviados u omitidos).
const READ_SQL = `SELECT
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'appointment_id', a.appointment_id, 'status', a.status, 'starts_at', a.starts_at, 'duration_min', a.duration_min, 'service', a.service,
    'suppressed', EXISTS (SELECT 1 FROM suppression_list s WHERE s.key = lower(c.email) OR s.key = c.phone),
    'contact', jsonb_build_object('contact_id', c.contact_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'timezone', c.timezone)
  ) ORDER BY a.starts_at)
   FROM appt_appointments a JOIN appt_contacts c ON c.contact_id = a.contact_id
   WHERE a.status IN ('scheduled', 'confirmed') AND a.starts_at > $1::timestamptz AND a.starts_at <= $1::timestamptz + interval '49 hours'), '[]'::jsonb) AS appts,
  COALESCE((SELECT jsonb_agg(r.appointment_id || '|' || r.kind) FROM appt_reminders r), '[]'::jsonb) AS sent`;

// El recordatorio se registra DESPUÉS de enviarse (clave cita|tipo). Si el envío falla no se registra: se reintenta en la siguiente corrida.
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
  SELECT x->>'contact_id', 'out', 'reminder_' || (x->>'kind'), x->>'text', 'sent', x->>'appointment_id', d.j->>'execution_id'
  FROM d, jsonb_array_elements(d.j->'rows') x WHERE x->>'status' = 'sent'
  RETURNING id
)
SELECT (SELECT count(*) FROM r) AS recorded, (SELECT count(*) FROM c) AS conversations, (SELECT count(*) FROM m) AS messages`;

module.exports = function remindersSend() {
  const w = Workflow('remindersend0001', 'Reminders · Send (Auditable)');

  w.add('Every 10 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/10 * * * *' }] } }, { notes: 'Cada 10 minutos.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'reminders-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/reminders-run con la cabecera x-reminders-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REM }, null, 2), includeOtherFields: true, options: {} })
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
return { json: { config: c, now, run_id: String($execution.id), validation: { ok: errors.length === 0, errors } } };`),
    { notes: 'El reloj es la hora real; "now" solo se acepta con el token y en modo mock, para probar plazos sin esperar horas.' })
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 200], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 480], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`));

  pg(w, 'Read Appointments', [col(4), 200], READ_SQL, '[$json.now]',
    { alwaysOutputData: true, notes: 'Citas activas de las próximas 49 h, su contacto, si está en la lista de bajas y los recordatorios ya registrados.' });
  w.add('Plan Reminders', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(
    [{ file: 'schedule', exports: [] }, { file: 'reminders', exports: ['planReminders'] }],
    `const s = $('Prepare').item.json;
const r = $input.item.json;
const plan = planReminders(r.appts, r.sent, s.now, s.config);
return { json: { ...s, appointments_open: r.appts.length, plan } };`)),
    { notes: 'DETERMINÍSTICO: qué recordatorio toca por cita (48 h: entre 48 y 24 h antes; 2 h: entre 2 h y 30 min antes), solo a citas activas, una vez, respetando las bajas y el horario de envío de la zona del contacto. Fuera de horario se difiere; si ya no habrá otra oportunidad se registra como omitido con el motivo.' })
   .add('Any Sends?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.plan.send.length > 0 }}'))
   .add('No Sends', 'n8n-nodes-base.code', 2, [col(7), 480], code(
    `const s = $input.item.json;
const rows = s.plan.skip.map(k => ({ appointment_id: k.appointment_id, kind: k.kind, status: 'skipped', reason: k.reason, contact_id: k.contact_id }));
return { json: { ...s, notices: [], rows, conv: [], failed: [], execution_id: String($execution.id) } };`),
    { notes: 'Nada que enviar ahora. Si hay omitidos (baja, sin canal, ventana cerrada), se registran igual con su motivo.' })
   .add('Expand Messages', 'n8n-nodes-base.code', 2, [col(7), 200], codeAll(
    `const s = $input.first().json;
return s.plan.send.map(m => ({ json: { from: s.config.fromEmail, to: m.to, phone: m.phone, text: m.text, appointment_id: m.appointment_id, kind: m.kind, contact_id: m.contact_id, starts_at: m.starts_at } }));`))
   .add('Send Reminder (SMS mock)', 'n8n-nodes-base.emailSend', 2.1, [col(8), 200], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: "={{ 'SMS · ' + ($json.phone || $json.to) }}",
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'En local el SMS es un correo a Mailpit. En live: GoHighLevel Conversations (contrato SIN verificar). Un envío fallido NO se registra: se reintenta en la siguiente corrida.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(9), 200], codeAll(
    `const s = $('Plan Reminders').first().json;
const out = $('Expand Messages').all();
const notices = $input.all().map((r, i) => ({ ...out[i].json, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const okOnes = notices.filter(n => n.ok);
const rows = [
  ...okOnes.map(n => ({ appointment_id: n.appointment_id, kind: n.kind, status: 'sent', to: n.to, contact_id: n.contact_id, text: n.text })),
  ...s.plan.skip.map(k => ({ appointment_id: k.appointment_id, kind: k.kind, status: 'skipped', reason: k.reason, contact_id: k.contact_id })),
];
// una conversación por contacto: la de la cita más próxima
const byContact = {};
for (const n of okOnes) if (!byContact[n.contact_id] || Date.parse(n.starts_at) < Date.parse(byContact[n.contact_id].starts_at)) byContact[n.contact_id] = n;
const conv = Object.values(byContact).map(n => ({ contact_id: n.contact_id, appointment_id: n.appointment_id }));
return [{ json: { ...s, notices: notices.map(n => ({ to: n.to, appointment_id: n.appointment_id, kind: n.kind, ok: n.ok, error: n.error })), rows, conv, failed: notices.filter(n => !n.ok).map(n => ({ to: n.to, error: n.error })), execution_id: String($execution.id) } }];`),
    { notes: 'Un recordatorio cuenta como enviado solo si el correo/SMS salió. Una conversación por contacto, apuntando a su cita más próxima.' });
  pg(w, 'Record Reminders', [col(10), 200], RECORD_SQL, '[JSON.stringify({ rows: $json.rows, conv: $json.conv, execution_id: $json.execution_id })]',
    { alwaysOutputData: true, notes: 'Registra lo enviado (y lo omitido con su motivo), deja a cada contacto "esperando respuesta" y guarda el mensaje. Una sola sentencia.' });
  w.add('Run Result', 'n8n-nodes-base.code', 2, [col(11), 200], code(
    `let s;
try { s = $('Collect Sends').first().json; } catch (e) { s = $('No Sends').first().json; }
const r = $input.item.json;
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, appointments_open: s.appointments_open, sent: s.rows.filter(x => x.status === 'sent').length, skipped: s.rows.filter(x => x.status === 'skipped').map(x => x.appointment_id + '|' + x.kind + ':' + x.reason), deferred: s.plan.defer.map(x => x.appointment_id + '|' + x.kind), recorded: Number(r.recorded), failed: s.failed } };`))
   .add('Assert Run', 'n8n-nodes-base.code', 2, [col(12), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('Reminders: ' + r.failed.length + ' message(s) failed and will be retried next run: ' + r.failed.map(f => f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'run_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Plan Reminders', { workflow: WF, step: 'reminders_planned', entity: '$json.run_id', detail: '({ now: $json.now, open: $json.appointments_open, send: $json.plan.send.map(s => s.appointment_id + "|" + s.kind), defer: $json.plan.defer, skip: $json.plan.skip })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'reminders_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices })' });

  w.note('## Reminders · Send\nEvery 10 minutes: code decides which reminder is due for each active appointment (48 h and 2 h before), skips opted-out contacts, respects the contact\'s sending hours, sends, and records a reminder only AFTER it was sent. A failed send is retried next run and fails loudly.', [col(0) - 20, -250], col(10), 110);

  w.link('Every 10 Minutes', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Appointments', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Appointments', 'Plan Reminders').link('Plan Reminders', 'Any Sends?')
   .link('Any Sends?', 'Expand Messages', 0).link('Any Sends?', 'No Sends', 1)
   .link('Expand Messages', 'Send Reminder (SMS mock)').link('Send Reminder (SMS mock)', 'Collect Sends').link('Collect Sends', 'Record Reminders')
   .link('No Sends', 'Record Reminders')
   .link('Record Reminders', 'Run Result').link('Run Result', 'Assert Run');

  return { file: 'reminders-send.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
