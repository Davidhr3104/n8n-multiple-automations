const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { ONB } = require('./onboarding-config');

const WF = 'onboarding-sequence';
const col = n => n * 240;
const O = exports_ => [{ file: 'schedule', exports: [] }, { file: 'onboarding', exports: exports_ }];

// Todo el trabajo pendiente en una fila: mensajes de la secuencia, contratos por firmar y contratos que no llegaron a salir.
const READ_SQL = `SELECT
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'client_id', b.client_id, 'kind', b.kind, 'send_after', b.send_after,
      'suppressed', EXISTS (SELECT 1 FROM suppression_list s WHERE s.key = lower(c.contact_email)),
      'client', jsonb_build_object('status', c.status, 'company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email)) ORDER BY b.send_after, b.id)
    FROM onb_outbox b JOIN onb_clients c ON c.client_id = b.client_id WHERE b.status = 'pending' AND b.send_after <= $1::timestamptz), '[]'::jsonb) AS outbox,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('client_id', k.client_id, 'status', c.status, 'sent_at', k.sent_at, 'expires_at', k.expires_at, 'nudged_at', k.nudged_at, 'escalated_at', k.escalated_at,
      'token', k.token, 'company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email, 'package', c.package) ORDER BY k.sent_at)
    FROM onb_contracts k JOIN onb_clients c ON c.client_id = k.client_id WHERE c.status = 'awaiting_signature'), '[]'::jsonb) AS contracts,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('client_id', c.client_id, 'token', k.token, 'text', k.text, 'company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email, 'package', c.package) ORDER BY c.created_at)
    FROM onb_clients c JOIN onb_contracts k ON k.client_id = c.client_id WHERE c.status = 'contract_pending' AND c.created_at < $1::timestamptz - interval '5 minutes'), '[]'::jsonb) AS pending`;

// Lo enviado y lo omitido (con motivo), los avisos de contrato y la caducidad, DESPUÉS de intentar enviar. Un mismo contrato se actualiza una sola vez por sentencia.
const RECORD_SQL = `WITH d AS (SELECT $1::jsonb AS j),
o AS (UPDATE onb_outbox b SET status = x->>'status', reason = NULLIF(x->>'reason', ''), sent_at = CASE WHEN x->>'status' = 'sent' THEN (d.j->>'now')::timestamptz END
      FROM d, jsonb_array_elements(d.j->'outbox') x WHERE b.id = (x->>'id')::bigint AND b.status = 'pending' RETURNING b.id),
kk AS (UPDATE onb_contracts k SET
         nudged_at = CASE WHEN k.client_id IN (SELECT jsonb_array_elements_text(d.j->'nudged')) THEN (d.j->>'now')::timestamptz ELSE k.nudged_at END,
         escalated_at = CASE WHEN k.client_id IN (SELECT jsonb_array_elements_text(d.j->'escalated')) THEN (d.j->>'now')::timestamptz ELSE k.escalated_at END
       FROM d WHERE k.client_id IN (SELECT jsonb_array_elements_text(d.j->'nudged') UNION SELECT jsonb_array_elements_text(d.j->'escalated')) RETURNING k.client_id),
ex AS (UPDATE onb_clients c SET status = 'expired', updated_at = now(), version = c.version + 1 FROM d
       WHERE c.client_id IN (SELECT jsonb_array_elements_text(d.j->'expired')) AND c.status = 'awaiting_signature' RETURNING c.client_id),
rs AS (UPDATE onb_clients c SET status = 'awaiting_signature', updated_at = now(), version = c.version + 1 FROM d
       WHERE c.client_id IN (SELECT jsonb_array_elements_text(d.j->'resent')) AND c.status = 'contract_pending' RETURNING c.client_id),
rk AS (UPDATE onb_contracts k SET sent_at = (d.j->>'now')::timestamptz FROM d WHERE k.client_id IN (SELECT jsonb_array_elements_text(d.j->'resent')) AND k.sent_at IS NULL RETURNING k.client_id),
st AS (INSERT INTO onb_steps (client_id, step, status, execution_id) SELECT client_id, 'contract_sent', 'ok', (SELECT j->>'execution_id' FROM d) FROM rs
       ON CONFLICT (client_id, step) DO UPDATE SET status = 'ok', error = NULL, execution_id = EXCLUDED.execution_id, created_at = now() RETURNING client_id),
e AS (INSERT INTO onb_events (client_id, event, actor, detail)
      SELECT x, ev, 'system', '{}'::jsonb FROM (
        SELECT x->>'client_id' AS x, 'welcome_' || (x->>'kind') AS ev FROM d, jsonb_array_elements(d.j->'outbox') x WHERE x->>'status' = 'sent'
        UNION ALL SELECT jsonb_array_elements_text(d.j->'nudged'), 'contract_nudged' FROM d
        UNION ALL SELECT jsonb_array_elements_text(d.j->'escalated'), 'contract_escalated' FROM d
        UNION ALL SELECT client_id, 'contract_expired' FROM ex UNION ALL SELECT client_id, 'contract_resent' FROM rs) q RETURNING id)
SELECT (SELECT count(*) FROM o) AS outbox, (SELECT count(*) FROM kk) AS contracts, (SELECT count(*) FROM ex) AS expired, (SELECT count(*) FROM rs) AS resent`;

module.exports = function onboardingSequence() {
  const w = Workflow('onboardingseq0001', 'Onboarding · Sequence & Follow-ups (Auditable)');

  w.add('Every 15 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] } }, { notes: 'Cada 15 minutos.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'onboarding-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/onboarding-run con la cabecera x-onboarding-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200], { mode: 'raw', jsonOutput: JSON.stringify({ config: ONB }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
let now = new Date().toISOString();
if (isWebhook) {
  if (item.headers['x-onboarding-token'] !== c.internalToken) errors.push('bad_token');
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

  pg(w, 'Read Work', [col(4), 200], READ_SQL, '[$json.now]', { alwaysOutputData: true, notes: 'Mensajes de la secuencia ya vencidos, contratos por firmar y contratos que no llegaron a salir.' });
  w.add('Plan Work', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(O(['dueOutbox', 'contractFollowUps', 'contractEmail', 'nudgeMessage', 'escalationNotice']),
    `const s = $('Prepare').item.json;
const r = $input.item.json;
const c = s.config;
const link = x => c.baseUrl + '/onboarding-sign?client_id=' + encodeURIComponent(x.client_id) + '&token=' + x.token;
const outbox = dueOutbox(r.outbox, s.now, c);
const fu = contractFollowUps(r.contracts, s.now, c);
const msgs = [];
for (const m of outbox.send) msgs.push({ type: 'outbox', id: m.id, client_id: m.client_id, kind: m.kind, to: m.to, subject: m.subject, text: m.text });
for (const k of fu.nudge) { const m = nudgeMessage({ client: { contact_name: k.contact_name, contact_email: k.contact_email }, link: link(k) }); msgs.push({ type: 'nudge', client_id: k.client_id, to: m.to, subject: m.subject, text: m.text }); }
for (const k of fu.escalate) { const m = escalationNotice({ client: { company: k.company, client_id: k.client_id }, ageDays: Math.floor((Date.parse(s.now) - Date.parse(k.sent_at)) / 864e5) }); msgs.push({ type: 'escalate', client_id: k.client_id, to: c.ownerEmail, subject: m.subject, text: m.text }); }
for (const k of fu.expire) msgs.push({ type: 'expire', client_id: k.client_id, to: c.ownerEmail, subject: 'Contract expired: ' + k.company, text: 'The agreement for ' + k.company + ' (' + k.client_id + ') expired without a signature after ' + c.contractExpiryDays + ' days. The client was marked as expired; nothing else was changed.' });
for (const p of r.pending) { const m = contractEmail({ client: { contact_name: p.contact_name, contact_email: p.contact_email, package: p.package }, contractText: p.text, link: link(p) }, c); msgs.push({ type: 'resend', client_id: p.client_id, to: m.to, subject: m.subject, text: m.text }); }
return { json: { ...s, outbox, followups: { nudge: fu.nudge.map(k => k.client_id), escalate: fu.escalate.map(k => k.client_id), expire: fu.expire.map(k => k.client_id) }, resend: r.pending.map(p => p.client_id), msgs } };`)),
    { notes: 'DETERMINÍSTICO: envía los mensajes de la secuencia ya vencidos (bienvenida, seguimiento a 2 días laborables, recordatorio del arranque) respetando bajas y horario; recuerda un contrato sin firmar a los 3 días, avisa al responsable a los 7 y lo caduca a los 14; reintenta contratos que no llegaron a salir. Cada cosa, una vez.' })
   .add('Anything To Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.msgs.length > 0 }}'))
   .add('Nothing To Send', 'n8n-nodes-base.code', 2, [col(7), 500], code(
    `const s = $input.item.json;
return { json: { ...s, record: { outbox: s.outbox.skip.map(k => ({ id: k.id, client_id: k.client_id, kind: k.kind, status: 'skipped', reason: k.reason })), nudged: [], escalated: [], expired: [], resent: [], now: s.now, execution_id: String($execution.id) }, failed: [], notices: [] } };`),
    { notes: 'Sin mensajes ahora. Los omitidos (baja, cliente cancelado) se registran igual con su motivo; los diferidos por horario se reintentan.' })
   .add('Expand Messages', 'n8n-nodes-base.code', 2, [col(7), 200], codeAll(
    `const s = $input.first().json;
return s.msgs.map(m => ({ json: { from: s.config.fromEmail, ...m } }));`))
   .add('Send Message', 'n8n-nodes-base.emailSend', 2.1, [col(8), 200], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local. Un envío fallido NO se registra: se reintenta en la siguiente corrida.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(9), 200], codeAll(
    `const s = $('Plan Work').first().json;
const out = $('Expand Messages').all();
const notices = $input.all().map((r, i) => ({ type: out[i].json.type, id: out[i].json.id, client_id: out[i].json.client_id, kind: out[i].json.kind, to: out[i].json.to, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const okBy = t => notices.filter(n => n.ok && n.type === t);
const record = {
  outbox: [...okBy('outbox').map(n => ({ id: n.id, client_id: n.client_id, kind: n.kind, status: 'sent' })), ...s.outbox.skip.map(k => ({ id: k.id, client_id: k.client_id, kind: k.kind, status: 'skipped', reason: k.reason }))],
  nudged: okBy('nudge').map(n => n.client_id), escalated: okBy('escalate').map(n => n.client_id), expired: okBy('expire').map(n => n.client_id), resent: okBy('resend').map(n => n.client_id),
  now: s.now, execution_id: String($execution.id),
};
return [{ json: { ...s, notices: notices.map(n => ({ type: n.type, client_id: n.client_id, to: n.to, ok: n.ok, error: n.error })), record, failed: notices.filter(n => !n.ok).map(n => ({ type: n.type, to: n.to, error: n.error })) } }];`),
    { notes: 'Cada cosa cuenta solo si el correo salió.' });
  pg(w, 'Record Work', [col(10), 200], RECORD_SQL, '[JSON.stringify($json.record)]', { alwaysOutputData: true, notes: 'Registra lo enviado y lo omitido con su motivo, los avisos de contrato, la caducidad y los contratos reenviados. Una sola sentencia.' });
  w.add('Run Result', 'n8n-nodes-base.code', 2, [col(11), 200], code(
    `let s;
try { s = $('Collect Sends').first().json; } catch (e) { s = $('Nothing To Send').first().json; }
const r = $input.item.json;
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, sent: s.notices.filter(n => n.ok).length, outbox_skipped: s.outbox.skip.map(k => k.client_id + ':' + k.kind + ':' + k.reason), outbox_deferred: s.outbox.defer.map(k => k.client_id + ':' + k.kind), nudged: s.record.nudged, escalated: s.record.escalated, expired: s.record.expired, resent: s.record.resent, failed: s.failed } };`))
   .add('Assert Run', 'n8n-nodes-base.code', 2, [col(12), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('Onboarding sequence: ' + r.failed.length + ' message(s) failed and will be retried next run: ' + r.failed.map(f => f.type + ' -> ' + f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'run_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Plan Work', { workflow: WF, step: 'work_planned', entity: '$json.run_id', detail: '({ now: $json.now, send: $json.outbox.send.map(m => m.client_id + ":" + m.kind), defer: $json.outbox.defer, skip: $json.outbox.skip, followups: $json.followups, resend: $json.resend })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'messages_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices })' });

  w.note('## Onboarding · Sequence & Follow-ups\nEvery 15 minutes: sends the welcome sequence that is due (respecting opt-outs and sending hours), nudges an unsigned contract after 3 days, alerts the account manager after 7 and expires it after 14, and retries contracts that never went out. Everything is recorded only after it was sent.', [col(0) - 20, -250], col(10), 110);

  w.link('Every 15 Minutes', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Work', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Work', 'Plan Work').link('Plan Work', 'Anything To Send?')
   .link('Anything To Send?', 'Expand Messages', 0).link('Anything To Send?', 'Nothing To Send', 1)
   .link('Expand Messages', 'Send Message').link('Send Message', 'Collect Sends').link('Collect Sends', 'Record Work')
   .link('Nothing To Send', 'Record Work')
   .link('Record Work', 'Run Result').link('Run Result', 'Assert Run');

  return { file: 'onboarding-sequence.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
