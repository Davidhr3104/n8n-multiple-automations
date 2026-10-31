const { Workflow, CRED, uid, code, ifBool, logBranch, pg } = require('../foundation');
const { SYNC } = require('./sync-config');

const WF = 'sync-weekly';
const col = n => n * 240;

// Cifras por SQL: sin IA. Lo que el resumen dice es exactamente lo que está en las tablas.
const STATS_SQL = `SELECT
  (SELECT count(*) FROM sync_links) AS links,
  (SELECT count(*) FROM execution_log WHERE workflow = 'sync-run' AND step = 'plan_applied' AND created_at > now() - interval '7 days') AS runs,
  (SELECT count(*) FROM execution_log WHERE workflow LIKE 'sync%' AND status = 'failed' AND created_at > now() - interval '7 days') AS failed_steps,
  (SELECT count(*) FROM sync_changes WHERE action = 'create' AND created_at > now() - interval '7 days') AS created,
  (SELECT count(*) FROM sync_changes WHERE action = 'update' AND created_at > now() - interval '7 days') AS updated_fields,
  (SELECT count(*) FROM sync_changes WHERE action = 'mark_duplicate' AND created_at > now() - interval '7 days') AS duplicates_marked,
  (SELECT count(*) FROM sync_changes WHERE action = 'resolve_conflict' AND created_at > now() - interval '7 days') AS conflicts_resolved_by_people,
  (SELECT count(*) FROM sync_conflicts WHERE status = 'open') AS open_conflicts,
  (SELECT count(*) FROM sync_issues WHERE resolved_at IS NULL) AS open_items,
  (SELECT count(*) FROM sync_issues WHERE resolved_at IS NULL AND kind = 'invalid_record') AS invalid_records,
  (SELECT count(*) FROM sync_issues WHERE resolved_at IS NULL AND kind = 'possible_duplicate') AS possible_duplicates`;

module.exports = function syncWeekly() {
  const w = Workflow('syncweekly00001', 'Sync · Weekly Summary (Auditable)');

  w.add('Weekly Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1' }] } }, { notes: 'Lunes 08:00.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'sync-weekly', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos: POST /webhook/sync-weekly con la cabecera x-sync-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SYNC }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
if (isWebhook && item.headers['x-sync-token'] !== c.internalToken) errors.push('bad_token');
return { json: { config: c, run_id: String($execution.id), validation: { ok: errors.length === 0, errors } } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 200], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 420], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`));

  pg(w, 'Weekly Stats', [col(4), 200], STATS_SQL, null, { notes: 'Todo por SQL contra las tablas del sync y el log de ejecución. Sin IA.' });
  w.add('Build Summary', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Prepare').item.json;
const r = Object.fromEntries(Object.entries($input.item.json).map(([k, v]) => [k, Number(v)]));
const lines = [s.config.dataLabel, '', 'Weekly sync summary (last 7 days)', '',
  'Linked contacts: ' + r.links,
  'Sync runs completed: ' + r.runs + (r.failed_steps ? '  |  FAILED steps: ' + r.failed_steps : ''),
  'Records created in the other system: ' + r.created,
  'Fields updated: ' + r.updated_fields,
  'Duplicates marked (nothing deleted): ' + r.duplicates_marked,
  'Conflicts resolved by a person: ' + r.conflicts_resolved_by_people, '',
  'Waiting for a person now:',
  '  Open conflicts: ' + r.open_conflicts,
  '  Other open items: ' + r.open_items + ' (invalid records: ' + r.invalid_records + ', possible duplicates: ' + r.possible_duplicates + ')'];
return { json: { ...s, stats: r, text: lines.join('\\n') } };`))
   .add('Send Summary Email', 'n8n-nodes-base.emailSend', 2.1, [col(6), 200], {
    resource: 'email', operation: 'send', fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Weekly CRM ↔ Sheets sync summary: ' + $json.stats.open_conflicts + ' open conflict(s)' }}",
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput' })
   .add('Final Result', 'n8n-nodes-base.code', 2, [col(7), 200], code(
    `const s = $('Build Summary').item.json;
const r = $input.item.json;
if (r.error) throw new Error('Weekly sync summary email failed: ' + JSON.stringify(r.error));
return { json: { status: 'sent', stats: s.stats } };`),
    { notes: 'Si el email falla, el flujo falla ruidosamente.' });

  logBranch(w, 'Build Summary', { workflow: WF, step: 'summary_built', entity: '$json.run_id', detail: '({ stats: $json.stats })' });

  w.note('## Sync · Weekly Summary\nNumbers straight from SQL, no AI: what the sync created, updated, marked as duplicates, and what still waits for a person.', [col(0) - 20, -250], col(6), 110);

  w.link('Weekly Schedule', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare').link('Prepare', 'Valid Request?')
   .link('Valid Request?', 'Weekly Stats', 0).link('Valid Request?', 'Rejected', 1)
   .link('Weekly Stats', 'Build Summary').link('Build Summary', 'Send Summary Email').link('Send Summary Email', 'Final Result');

  return { file: 'sync-weekly.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
