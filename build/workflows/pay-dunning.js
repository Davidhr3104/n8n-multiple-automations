const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { PAY } = require('./pay-config');

const WF = 'pay-dunning';
const col = n => n * 240;
// payments.js usa ./schedule: debe registrarse antes o el nodo falla al cargar en n8n
const L = exports_ => [{ file: 'schedule', exports: [] }, { file: 'payments', exports: exports_ }];

// Todas las facturas abiertas con lo necesario para decidir: saldo (amount - paid_total), bajas y etapas ya enviadas.
const READ_SQL = `SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_id', i.invoice_id, 'contact_email', i.contact_email, 'customer_name', i.customer_name, 'timezone', i.timezone,
    'amount', i.amount, 'paid_total', i.paid_total, 'currency', i.currency, 'due_date', i.due_date::text, 'status', i.status, 'paused_until', i.paused_until, 'promise_count', i.promise_count,
    'suppressed', EXISTS (SELECT 1 FROM suppression_list s WHERE s.key = lower(i.contact_email)),
    'sent_stages', COALESCE((SELECT jsonb_agg(r.stage) FROM pay_reminders r WHERE r.invoice_id = i.invoice_id AND r.status IN ('sent', 'escalated')), '[]'::jsonb)) ORDER BY i.due_date, i.invoice_id), '[]'::jsonb) AS rows
FROM pay_invoices i WHERE i.status = 'open'`;

// Cada etapa cuenta solo si el correo salió. Una etapa por factura (PRIMARY KEY): nunca se envía dos veces.
const RECORD_SQL = `WITH d AS (SELECT $1::jsonb AS j),
r AS (INSERT INTO pay_reminders (invoice_id, stage, status, sent_at) SELECT x->>'invoice_id', x->>'stage', x->>'status', (d.j->>'now')::timestamptz FROM d, jsonb_array_elements(d.j->'reminders') x
      ON CONFLICT (invoice_id, stage) DO NOTHING RETURNING invoice_id, stage, status),
e AS (INSERT INTO pay_events (invoice_id, event, actor, detail) SELECT invoice_id, CASE status WHEN 'sent' THEN 'reminder_sent' WHEN 'escalated' THEN 'escalated_to_person' ELSE 'stage_superseded' END, 'system', jsonb_build_object('stage', stage) FROM r RETURNING id)
SELECT (SELECT count(*) FROM r WHERE status = 'sent') AS sent, (SELECT count(*) FROM r WHERE status = 'escalated') AS escalated, (SELECT count(*) FROM r WHERE status = 'superseded') AS superseded`;

module.exports = function payDunning() {
  const w = Workflow('paydunning000001', 'Payments · Daily Reminders (Auditable)');

  w.add('Daily 09:00', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] } }, { notes: 'Una vez al día, 09:00.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'pay-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/pay-run con la cabecera x-pay-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200], { mode: 'raw', jsonOutput: JSON.stringify({ config: PAY }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
let now = new Date().toISOString();
if (isWebhook) {
  if (item.headers['x-pay-token'] !== c.internalToken) errors.push('bad_token');
  const n = item.body && item.body.now;
  if (n !== undefined && n !== '') {
    if (!c.allowTimeOverride) errors.push('time_override_not_allowed');
    else if (typeof n !== 'string' || !Number.isFinite(Date.parse(n))) errors.push('now');
    else now = new Date(n).toISOString();
  }
}
return { json: { config: c, now, run_id: String($execution.id), validation: { ok: errors.length === 0, errors } } };`),
    { notes: 'El reloj es la hora real; "now" solo se acepta con el token y en modo mock.' })
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 200], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 500], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`));

  pg(w, 'Read Invoices', [col(4), 200], READ_SQL, null, { alwaysOutputData: true, notes: 'Facturas abiertas con su saldo (importe − pagado), bajas y etapas ya enviadas. Se lee en la misma corrida que envía, segundos antes.' });
  w.add('Plan Reminders', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(L(['planDunning', 'buildMessage', 'finalNotice']),
    `const s = $('Prepare').item.json;
const r = $input.item.json;
const c = s.config;
const plan = planDunning(r.rows, s.now, c);
const msgs = [];
for (const g of plan.send) { const m = buildMessage(g, c); msgs.push({ type: 'customer', to: m.to, subject: m.subject, text: m.text, reminders: g.invoices.map(i => ({ invoice_id: i.invoice_id, stage: i.stage, status: 'sent' })).concat(g.superseded.map(x => ({ invoice_id: x.invoice_id, stage: x.stage, status: 'superseded' }))) }); }
const byContact = new Map();
for (const e of plan.escalate) { const k = e.contact_email.toLowerCase(); if (!byContact.has(k)) byContact.set(k, { to: k, customer_name: e.customer_name, invoices: [] }); byContact.get(k).invoices.push(e); }
for (const g of byContact.values()) { const m = finalNotice(g); msgs.push({ type: 'escalate', to: c.ownerEmail, subject: m.subject, text: m.text, reminders: g.invoices.map(i => ({ invoice_id: i.invoice_id, stage: 'final', status: 'escalated' })) }); }
return { json: { ...s, plan: { send: plan.send.map(g => g.to + ':' + g.invoices.map(i => i.invoice_id + '/' + i.stage).join(',')), defer: plan.defer.map(d => d.invoice_id + ':' + d.reason), skip: plan.skip.map(k => k.invoice_id + ':' + k.reason), escalate: plan.escalate.map(e => e.invoice_id) }, msgs } };`)),
    { notes: 'DETERMINÍSTICO: solo facturas abiertas con saldo, sin pausa ni baja, dentro del horario del cliente. Se envía la etapa que toca (las atrasadas no se acumulan) y un solo mensaje por contacto. La etapa final no escribe al cliente: avisa a una persona.' })
   .add('Anything To Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.msgs.length > 0 }}'))
   .add('Nothing To Send', 'n8n-nodes-base.code', 2, [col(7), 500], code(
    `const s = $input.item.json;
return { json: { ...s, record: { reminders: [], now: s.now }, failed: [], notices: [] } };`))
   .add('Expand Messages', 'n8n-nodes-base.code', 2, [col(7), 200], codeAll(
    `const s = $input.first().json;
return s.msgs.map(m => ({ json: { from: s.config.fromEmail, ...m } }));`))
   .add('Send Message', 'n8n-nodes-base.emailSend', 2.1, [col(8), 200], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local (en live: SMS / WhatsApp o el correo de facturación). Un envío fallido NO se registra: se reintenta en la siguiente corrida.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(9), 200], codeAll(
    `const s = $('Plan Reminders').first().json;
const out = $('Expand Messages').all();
const notices = $input.all().map((r, i) => ({ type: out[i].json.type, to: out[i].json.to, reminders: out[i].json.reminders, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const record = { reminders: notices.filter(n => n.ok).flatMap(n => n.reminders), now: s.now };
return [{ json: { ...s, notices: notices.map(n => ({ type: n.type, to: n.to, ok: n.ok, error: n.error })), record, failed: notices.filter(n => !n.ok).map(n => ({ type: n.type, to: n.to, error: n.error })) } }];`),
    { notes: 'Cada etapa cuenta solo si el correo salió.' });
  pg(w, 'Record Reminders', [col(10), 200], RECORD_SQL, '[JSON.stringify($json.record)]', { alwaysOutputData: true, notes: 'Registra las etapas enviadas, las saltadas (superseded) y los avisos a persona. Una etapa por factura: nunca se repite.' });
  w.add('Run Result', 'n8n-nodes-base.code', 2, [col(11), 200], code(
    `let s;
try { s = $('Collect Sends').first().json; } catch (e) { s = $('Nothing To Send').first().json; }
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, sent: s.notices.filter(n => n.type === 'customer' && n.ok).length, escalated: s.notices.filter(n => n.type === 'escalate' && n.ok).length, plan: s.plan, failed: s.failed } };`))
   .add('Assert Run', 'n8n-nodes-base.code', 2, [col(12), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('Payment reminders: ' + r.failed.length + ' message(s) failed and will be retried next run: ' + r.failed.map(f => f.type + ' -> ' + f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'run_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Plan Reminders', { workflow: WF, step: 'work_planned', entity: '$json.run_id', detail: '({ now: $json.now, plan: $json.plan })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'messages_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices })' });

  w.note('## Payments · Daily Reminders\nEvery day: reads the open invoices with their balance, and code decides who is due: upcoming, due, 7 and 14 days overdue (one message per customer, the latest stage only). At 30 days it writes to a person, not to the customer. Paid, disputed, paused and opted-out invoices are skipped, and a stage counts as sent only after the email went out.', [col(0) - 20, -250], col(10), 110);

  w.link('Daily 09:00', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Invoices', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Invoices', 'Plan Reminders').link('Plan Reminders', 'Anything To Send?')
   .link('Anything To Send?', 'Expand Messages', 0).link('Anything To Send?', 'Nothing To Send', 1)
   .link('Expand Messages', 'Send Message').link('Send Message', 'Collect Sends').link('Collect Sends', 'Record Reminders')
   .link('Nothing To Send', 'Record Reminders')
   .link('Record Reminders', 'Run Result').link('Run Result', 'Assert Run');

  return { file: 'pay-dunning.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
