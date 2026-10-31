const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg } = require('../foundation');
const { SOP } = require('./sop-config');

const WF = 'sop-sweep';
const col = n => n * 240;
const L = exports_ => [{ file: 'sop', exports: exports_ }];

const READ_SQL = `SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.sop_id) FROM sop_docs d WHERE d.status = 'published'), '[]'::jsonb) AS docs,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('sop_id', v.sop_id, 'version', v.version, 'created_at', v.created_at, 'pending_reminded_at', v.pending_reminded_at, 'title', d.title, 'owner_email', d.owner_email) ORDER BY v.created_at)
            FROM sop_versions v JOIN sop_docs d ON d.sop_id = v.sop_id WHERE v.status = 'pending_review'), '[]'::jsonb) AS pending`;

// Cada aviso cuenta solo si el correo salió; se registra una sola vez por ciclo.
const RECORD_SQL = `WITH d AS (SELECT $1::jsonb AS j),
a AS (UPDATE sop_docs s SET review_reminded_at = (d.j->>'now')::timestamptz FROM d WHERE s.sop_id IN (SELECT jsonb_array_elements_text(d.j->'reminded')) AND s.review_reminded_at IS NULL RETURNING s.sop_id),
b AS (UPDATE sop_docs s SET review_escalated_at = (d.j->>'now')::timestamptz FROM d WHERE s.sop_id IN (SELECT jsonb_array_elements_text(d.j->'escalated')) AND s.review_escalated_at IS NULL RETURNING s.sop_id),
c AS (UPDATE sop_versions v SET pending_reminded_at = (d.j->>'now')::timestamptz FROM d, jsonb_array_elements(d.j->'pending') x
      WHERE v.sop_id = x->>'sop_id' AND v.version = (x->>'version')::int AND v.pending_reminded_at IS NULL RETURNING v.sop_id),
e AS (INSERT INTO sop_events (sop_id, version, event, actor, detail)
      SELECT x, NULL, ev, 'system', '{}'::jsonb FROM (
        SELECT jsonb_array_elements_text(d.j->'reminded') AS x, 'review_reminded' AS ev FROM d
        UNION ALL SELECT jsonb_array_elements_text(d.j->'escalated'), 'review_escalated' FROM d
        UNION ALL SELECT sop_id, 'pending_reminded' FROM c) q RETURNING id)
SELECT (SELECT count(*) FROM a) AS reminded, (SELECT count(*) FROM b) AS escalated, (SELECT count(*) FROM c) AS pending`;

module.exports = function sopSweep() {
  const w = Workflow('sopsweep0000001', 'SOP · Review Sweep (Auditable)');

  w.add('Daily 08:00', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }, { notes: 'Una vez al día, 08:00.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'sop-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/sop-run con la cabecera x-sop-token. El cuerpo puede traer "now" (solo en modo mock).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200], { mode: 'raw', jsonOutput: JSON.stringify({ config: SOP }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
let now = new Date().toISOString();
if (isWebhook) {
  if (item.headers['x-sop-token'] !== c.internalToken) errors.push('bad_token');
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

  pg(w, 'Read Work', [col(4), 200], READ_SQL, null, { alwaysOutputData: true, notes: 'SOP publicados y versiones pendientes de aprobación.' });
  w.add('Plan Work', 'n8n-nodes-base.code', 2, [col(5), 200], code(embed(L(['reviewDue', 'reviewReminder', 'reviewEscalation', 'pendingReminder']),
    `const s = $('Prepare').item.json;
const r = $input.item.json;
const c = s.config;
const due = reviewDue(r.docs, r.pending, s.now, c);
const link = d => c.baseUrl + '/sop-view?sop_id=' + encodeURIComponent(d.sop_id);
const age = d => Math.floor((Date.parse(s.now) - Date.parse(d.published_at)) / 864e5);
const msgs = [];
for (const d of due.remind) { const m = reviewReminder({ doc: d, link: link(d) }); msgs.push({ type: 'remind', sop_id: d.sop_id, to: m.to, subject: m.subject, text: m.text }); }
for (const d of due.escalate) { const m = reviewEscalation({ doc: d, ageDays: age(d) }); msgs.push({ type: 'escalate', sop_id: d.sop_id, to: c.opsEmail, subject: m.subject, text: m.text }); }
for (const v of due.pending) { const m = pendingReminder({ v }); msgs.push({ type: 'pending', sop_id: v.sop_id, version: v.version, to: m.to, subject: m.subject, text: m.text }); }
return { json: { ...s, due: { remind: due.remind.map(d => d.sop_id), escalate: due.escalate.map(d => d.sop_id), pending: due.pending.map(v => v.sop_id + ':' + v.version) }, msgs } };`)),
    { notes: 'DETERMINÍSTICO: a los 90 días el responsable recibe un recordatorio; 14 días después sin acción se avisa a operaciones; una versión pendiente de aprobación se recuerda una vez. Cada aviso, una sola vez.' })
   .add('Anything To Send?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.msgs.length > 0 }}'))
   .add('Nothing To Send', 'n8n-nodes-base.code', 2, [col(7), 500], code(
    `const s = $input.item.json;
return { json: { ...s, record: { reminded: [], escalated: [], pending: [], now: s.now }, failed: [], notices: [] } };`))
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
const notices = $input.all().map((r, i) => ({ type: out[i].json.type, sop_id: out[i].json.sop_id, version: out[i].json.version, to: out[i].json.to, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
const okBy = t => notices.filter(n => n.ok && n.type === t);
const record = { reminded: okBy('remind').map(n => n.sop_id), escalated: okBy('escalate').map(n => n.sop_id), pending: okBy('pending').map(n => ({ sop_id: n.sop_id, version: n.version })), now: s.now };
return [{ json: { ...s, notices, record, failed: notices.filter(n => !n.ok).map(n => ({ type: n.type, to: n.to, error: n.error })) } }];`),
    { notes: 'Cada aviso cuenta solo si el correo salió.' });
  pg(w, 'Record Work', [col(10), 200], RECORD_SQL, '[JSON.stringify($json.record)]', { alwaysOutputData: true, notes: 'Registra los avisos enviados, una sola vez por ciclo.' });
  w.add('Run Result', 'n8n-nodes-base.code', 2, [col(11), 200], code(
    `let s;
try { s = $('Collect Sends').first().json; } catch (e) { s = $('Nothing To Send').first().json; }
return { json: { status: s.failed.length ? 'partial' : 'ok', now: s.now, sent: s.notices.filter(n => n.ok).length, due: s.due, reminded: s.record.reminded, escalated: s.record.escalated, pending_reminded: s.record.pending.map(p => p.sop_id + ':' + p.version), failed: s.failed } };`))
   .add('Assert Run', 'n8n-nodes-base.code', 2, [col(12), 200], code(
    `const r = $input.item.json;
if (r.failed.length > 0) throw new Error('SOP sweep: ' + r.failed.length + ' message(s) failed and will be retried next run: ' + r.failed.map(f => f.type + ' -> ' + f.to + ' ' + f.error).join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de registrar lo que sí se envió → Error Handler.' });

  logBranch(w, 'Prepare', { workflow: WF, step: 'run_started', entity: '$json.run_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')", detail: '({ now: $json.now })' });
  logBranch(w, 'Plan Work', { workflow: WF, step: 'work_planned', entity: '$json.run_id', detail: '({ now: $json.now, due: $json.due })' });
  logBranch(w, 'Collect Sends', { workflow: WF, step: 'messages_sent', entity: '$json.run_id', status: "$json.failed.length ? 'failed' : 'ok'", error: "$json.failed.map(f => f.to).join(',')", detail: '({ notices: $json.notices })' });

  w.note('## SOP · Review Sweep\nDaily: reminds the owner when a published procedure is 90 days old, alerts operations 14 days after an unanswered reminder, and nudges a version that is still waiting for approval. Each notice goes out once, and is recorded only after the email was sent.', [col(0) - 20, -250], col(10), 110);

  w.link('Daily 08:00', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Read Work', 0).link('Valid Request?', 'Rejected', 1)
   .link('Read Work', 'Plan Work').link('Plan Work', 'Anything To Send?')
   .link('Anything To Send?', 'Expand Messages', 0).link('Anything To Send?', 'Nothing To Send', 1)
   .link('Expand Messages', 'Send Message').link('Send Message', 'Collect Sends').link('Collect Sends', 'Record Work')
   .link('Nothing To Send', 'Record Work')
   .link('Record Work', 'Run Result').link('Run Result', 'Assert Run');

  return { file: 'sop-sweep.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
