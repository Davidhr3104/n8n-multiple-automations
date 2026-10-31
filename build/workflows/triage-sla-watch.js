const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { TRIAGE } = require('./triage-config');

const WF = 'triage-sla-watch';
const col = n => n * 240;

// Tickets abiertos y las alertas que ya se enviaron para ellos: una sola fila.
const OPEN_SQL = `SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.ticket_id) FROM (
    SELECT ticket_id, priority, subject, assignee_email, first_response_due, resolution_due, first_response_at, resolved_at
    FROM triage_tickets WHERE status = 'open') t), '[]'::jsonb) AS tickets,
  COALESCE((SELECT jsonb_agg(a.alert_key) FROM triage_sla_alerts a JOIN triage_tickets t ON t.ticket_id = a.ticket_id WHERE t.status = 'open'), '[]'::jsonb) AS sent`;

// La alerta se registra DESPUÉS de enviarse. ON CONFLICT DO NOTHING: dos corridas solapadas no la duplican en la tabla.
const RECORD_SQL = `WITH ins AS (
  INSERT INTO triage_sla_alerts (alert_key, ticket_id, recipients)
  SELECT x->>'key', x->>'ticket_id', COALESCE(x->'recipients', '[]'::jsonb) FROM jsonb_array_elements($1::jsonb) x
  ON CONFLICT (alert_key) DO NOTHING
  RETURNING alert_key
)
SELECT count(*) AS recorded FROM ins`;

module.exports = function triageSlaWatch() {
  const w = Workflow('triageslawatch01', 'Triage · SLA Watcher (Auditable)');

  w.add('Every 5 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/5 * * * *' }] } }, { notes: 'Cada 5 minutos.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'triage-sla-watch', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/triage-sla-watch con la cabecera x-triage-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: TRIAGE }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
let now = new Date().toISOString();
if (isWebhook) {
  if (item.headers['x-triage-token'] !== c.internalToken) errors.push('bad_token');
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
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 460], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`));

  pg(w, 'Read Open Tickets', [col(4), 200], OPEN_SQL, null,
    { alwaysOutputData: true, notes: 'Todos los tickets abiertos y las alertas de SLA ya enviadas para ellos.' });
  w.add('Compute Alerts', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(
    [{ file: 'triage', exports: ['pendingAlerts', 'alertEmails'] }],
    `const s = $('Prepare').item.json;
const r = $input.item.json;
const alerts = pendingAlerts(r.tickets, r.sent, s.now, s.config);
const emails = alertEmails(alerts, r.tickets, s.config);
return { json: { ...s, open_tickets: r.tickets.length, alerts, emails } };`)),
    { notes: 'DETERMINÍSTICO: por cada reloj abierto calcula ok / aviso (≥75 % del plazo) / incumplido, descarta lo ya avisado y agrupa por destinatario: la persona asignada ve lo suyo, el líder ve incumplimientos y tickets sin asignar.' })
   .add('Any Alerts?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.alerts.length > 0 }}'))
   .add('Nothing To Send', 'n8n-nodes-base.code', 2, [col(7), 460], code(
    `const s = $input.item.json;
return { json: { status: 'ok', now: s.now, open_tickets: s.open_tickets, alerts: 0, sent: 0, failed: [] } };`),
    { notes: 'Sin alertas nuevas (o ya enviadas): no se envía nada.' })
   .add('Expand Emails', 'n8n-nodes-base.code', 2, [col(7), 200], codeAll(
    `const s = $input.first().json;
return s.emails.map(m => ({ json: { from: s.config.fromEmail, to: m.to, subject: m.subject, text: m.text, alert_keys: m.alert_keys } }));`))
   .add('Send Alert Email', 'n8n-nodes-base.emailSend', 2.1, [col(8), 200], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local. Un envío fallido NO registra la alerta: se reintenta en la siguiente corrida y el flujo falla ruidosamente.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(9), 200], codeAll(
    `const s = $('Compute Alerts').first().json;
const mails = $('Expand Emails').all();
const notices = $input.all().map((r, i) => ({ to: mails[i].json.to, alert_keys: mails[i].json.alert_keys, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const okKeys = new Set(notices.filter(n => n.ok).flatMap(n => n.alert_keys));
const to_record = s.alerts.filter(a => okKeys.has(a.key)).map(a => ({ key: a.key, ticket_id: a.ticket_id, recipients: notices.filter(n => n.ok && n.alert_keys.includes(a.key)).map(n => n.to) }));
return [{ json: { ...s, notices, to_record, failed: notices.filter(n => !n.ok).map(n => ({ to: n.to, error: n.error })) } }];`),
    { notes: 'Una alerta cuenta como enviada si al menos un destinatario la recibió.' });
  pg(w, 'Record Alerts', [col(10), 200], RECORD_SQL, '[JSON.stringify($json.to_record)]',
    { alwaysOutputData: true, notes: 'Solo las alertas efectivamente enviadas. Así cada aviso sale una vez y un fallo de envío se reintenta.' });
  w.add('Watch Result', 'n8n-nodes-base.code', 2, [col(11), 200], code(
    `const s = $('Collect Sends').item.json;
const r = $input.item.json;
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, open_tickets: s.open_tickets, alerts: s.alerts.length, sent: s.to_record.length, recorded: Number(r.recorded), failed: s.failed } };`))
   .add('Assert Watch', 'n8n-nodes-base.code', 2, [col(12), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('SLA watcher: ' + r.failed.length + ' alert email(s) failed and will be retried: ' + r.failed.map(f => f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'watch_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Compute Alerts', { workflow: WF, step: 'alerts_computed', entity: '$json.run_id', detail: '({ now: $json.now, open_tickets: $json.open_tickets, alerts: $json.alerts.map(a => a.key) })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'alerts_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices.map(n => ({ to: n.to, ok: n.ok })) })' });

  w.note('## Triage · SLA Watcher\nEvery 5 minutes: code computes each open ticket\'s clocks (ok / at risk at 75 % of the window / breached), skips alerts already sent, and emails the assignee and the lead. An alert is recorded only after it was sent, so a failed send is retried and the error is visible.', [col(0) - 20, -250], col(10), 110);

  w.link('Every 5 Minutes', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Open Tickets', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Open Tickets', 'Compute Alerts').link('Compute Alerts', 'Any Alerts?')
   .link('Any Alerts?', 'Expand Emails', 0).link('Any Alerts?', 'Nothing To Send', 1)
   .link('Expand Emails', 'Send Alert Email').link('Send Alert Email', 'Collect Sends').link('Collect Sends', 'Record Alerts')
   .link('Record Alerts', 'Watch Result').link('Watch Result', 'Assert Watch');

  return { file: 'triage-sla-watch.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
