const { Workflow, embed, CRED, uid, code, codeAll, ifBool, ifEquals, logBranch, pg, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-run';
const col = n => n * 240;

// Los textos que llegan a emails de aprobación pueden contener datos del CRM (no confiables): se neutralizan & < >
// con homoglifos porque n8n decodifica entidades HTML al armar el email (verificado en 2.43.4).
const ESC = `const esc = v => String(v).replace(/&/g, "\\uFF06").replace(/</g, "\\u2039").replace(/>/g, "\\u203A");`;

module.exports = function revivalRun() {
  const w = Workflow('revivalrun000001', 'Revival · Daily Run (Auditable)');

  // ── Disparo + idempotencia diaria ──
  w.add('Daily Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] } },
    { notes: 'Lunes a viernes 09:00. Idempotente por día: no corre dos veces el mismo día.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'revival-run', responseMode: 'onReceived', options: {} },
    { webhookId: uid(), notes: 'Para demos: POST /webhook/revival-run. Cada llamada manual es una corrida distinta.' })
   .add('Prepare Run', 'n8n-nodes-base.code', 2, [col(1), 200], code(
    `const trigger = $('Daily Schedule').isExecuted ? 'schedule' : 'manual';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
return { json: { trigger, batch_id: 'rev_' + day + '_' + $execution.id, config: ${JSON.stringify(REVIVAL)} } };`),
    { notes: 'Config del revival (edítala en build/workflows/revival-config.js): inactividad, tope por corrida, toques, espaciado, modos.' });

  idempotency(w, {
    workflow: WF, position: [col(2), 200], paramCount: 1, params: '$json.trigger', stateFrom: 'Prepare Run', check: 'New run?',
    keySql: "CASE WHEN $1 = 'schedule' THEN 'revival-run:' || to_char(date_trunc('day', now()), 'YYYY-MM-DD') ELSE 'revival-run:manual:' || $2 END",
  });
  w.add('Skip (already ran)', 'n8n-nodes-base.noOp', 1, [col(5), 520], {}, { notes: 'La corrida de hoy ya se hizo (o está en curso).' });

  // ── Selección: contactos nuevos inactivos + toques pendientes ──
  pg(w, 'Load Suppression', [col(5), 120],
    `SELECT (SELECT COALESCE(jsonb_agg(key), '[]'::jsonb) FROM suppression_list) AS keys,
       (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM (
          SELECT lower(c.email) AS k FROM revival_state s JOIN revival_contacts c ON c.contact_id = s.contact_id WHERE c.email IS NOT NULL
          UNION
          SELECT norm_phone(c.phone, '57') FROM revival_state s JOIN revival_contacts c ON c.contact_id = s.contact_id WHERE norm_phone(c.phone, '57') IS NOT NULL
       ) e) AS engaged`, null,
    { notes: 'keys = lista de bajas completa (se vuelve a consultar en Send Touch justo antes de cada envío). engaged = email/teléfono de quienes YA tienen secuencia: un duplicado suyo no recibe primer toque.' });
  pg(w, 'Load Candidates', [col(6), 120],
    `WITH new_c AS (
  SELECT c.contact_id, c.name, c.email, c.phone, c.company, c.last_activity_at, c.history, 'new' AS kind, 1 AS touch
  FROM revival_contacts c LEFT JOIN revival_state s ON s.contact_id = c.contact_id
  WHERE s.contact_id IS NULL AND c.last_activity_at < now() - make_interval(days => $1::int)
  ORDER BY c.last_activity_at DESC LIMIT ($2::int * 4)
), due AS (
  SELECT c.contact_id, c.name, c.email, c.phone, c.company, c.last_activity_at, c.history, 'follow_up' AS kind, s.step + 1 AS touch
  FROM revival_state s JOIN revival_contacts c ON c.contact_id = s.contact_id
  WHERE s.status = 'active' AND s.next_touch_at <= now() AND s.step < $3::int
)
SELECT * FROM due UNION ALL SELECT * FROM new_c`,
    "[$('Prepare Run').item.json.config.inactivityDays, $('Prepare Run').item.json.config.maxPerRun, $('Prepare Run').item.json.config.maxTouches]",
    { alwaysOutputData: true, notes: 'Contactos inactivos sin secuencia + toques de seguimiento ya vencidos. En modo live este paso sería la búsqueda de contactos en la API de GHL (contrato sin verificar).' });
  w.add('Select Candidates', 'n8n-nodes-base.code', 2, [col(7), 120], codeAll(embed(
    [{ file: 'revival', exports: ['selectCandidates'] }],
    `const base = $('Idempotency Result').first().json;
const lists = $('Load Suppression').first().json;
const keys = new Set(lists.keys || []);
const engaged = new Set(lists.engaged || []);
const rows = $input.all().map(i => i.json).filter(r => r.contact_id);
const { selected, skipped } = selectCandidates(rows, { max: base.config.maxPerRun, suppressed: keys, engaged, defaultCountryCode: base.config.defaultCountryCode });
const skipped_counts = skipped.reduce((a, s) => { const k = s.reason.split(':')[0]; a[k] = (a[k] || 0) + 1; return a; }, {});
return [{ json: { ...base, candidates_found: rows.length, selected, skipped, skipped_counts } }];`)),
    { notes: 'DETERMINÍSTICO: filtra inválidos y bajas, deduplica por email/teléfono, pone los follow-ups primero y aplica el tope.' })
   .add('Any candidates?', 'n8n-nodes-base.if', 2.2, [col(8), 120], ifBool('={{ $json.selected.length > 0 }}'))
   .add('No Candidates', 'n8n-nodes-base.code', 2, [col(9), 520], code(
    `return { json: { ...$input.item.json, run_status: 'nothing_to_do' } };`));

  // ── Aprobación del LOTE (acción externa masiva) ──
  pg(w, 'Create Batch', [col(9), 120],
    "INSERT INTO revival_batches (batch_id, status, size, execution_id) VALUES ($1, 'pending_approval', $2::int, $3) RETURNING batch_id",
    '[$json.batch_id, $json.selected.length, $execution.id]',
    { notes: 'El lote queda "pending_approval". Send Touch NO envía nada si su lote no está "approved".' });
  w.add('Batch Created', 'n8n-nodes-base.code', 2, [col(10), 120], code(
    `return { json: { ...$('Any candidates?').item.json } };`))
   .add('Build Preview', 'n8n-nodes-base.code', 2, [col(11), 120], code(embed(
    [{ file: 'revival', exports: ['mockTouch'] }],
    `const s = $input.item.json;
const newN = s.selected.filter(r => r.kind === 'new').length;
const fu = s.selected.length - newN;
const lines = [
  'BATCH ' + s.batch_id + ': ' + s.selected.length + ' contacts to message (' + newN + ' new, ' + fu + ' follow-ups)',
  'Skipped: ' + (Object.entries(s.skipped_counts).map(([k, v]) => k + ' ' + v).join(', ') || 'none'),
  '',
  'WHO:',
  ...s.selected.map(r => '  - ' + r.name + ' <' + r.email + '> — touch ' + r.touch + ' (' + r.kind + ')'),
  '',
  'SAMPLE TEXT (deterministic preview; the real text is written per lead and logged):',
  ...s.selected.slice(0, 3).map(r => '  [' + r.name + '] ' + mockTouch(r, r.touch)),
  '',
  'Nothing is sent unless you approve this batch. Every message also gets an opt-out footer and a suppression check right before sending.',
];
${ESC}
return { json: { ...s, preview_text: lines.join("\\n"), preview_message: lines.map(esc).join("\\n") } };`)))
   .add('Request Batch Approval', 'n8n-nodes-base.emailSend', 2.1, [col(12), 0], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Approve revival batch (' + $json.selected.length + ' contacts)' }}",
    message: '={{ $json.preview_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve batch', disapproveLabel: 'Reject batch' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Aprobación humana ANTES de cualquier envío. Canal: email (Mailpit local). Para Slack, cambiar este nodo por Slack → Send and Wait.' })
   .add('Apply Decision', 'n8n-nodes-base.code', 2, [col(13), 0], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Preview').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: timeout o respuesta ambigua = lote NO aprobado.' })
   .add('Batch Approved?', 'n8n-nodes-base.if', 2.2, [col(14), 0], ifEquals('={{ $json.human.status }}', 'approved_by_human'));

  // ── Rechazado / sin respuesta ──
  pg(w, 'Reject Batch', [col(15), 300],
    'UPDATE revival_batches SET status = $2, decided_at = now() WHERE batch_id = $1 RETURNING batch_id',
    "[$json.batch_id, $json.human.status === 'no_human_response' ? 'no_response' : 'rejected']", { alwaysOutputData: true });
  w.add('Batch Rejected', 'n8n-nodes-base.code', 2, [col(16), 300], code(
    `const s = $('Apply Decision').item.json;
return { json: { ...s, run_status: s.human.status === 'no_human_response' ? 'batch_no_response' : 'batch_rejected' } };`));

  // ── Aprobado: despacho un webhook por lead (cada toque es su propia ejecución, auditable) ──
  pg(w, 'Approve Batch', [col(15), -40],
    "UPDATE revival_batches SET status = 'approved', decided_at = now() WHERE batch_id = $1 AND status = 'pending_approval' RETURNING batch_id",
    '[$json.batch_id]', { alwaysOutputData: true, notes: 'Solo aprueba si el lote seguía "pending_approval".' });
  w.add('Expand Batch', 'n8n-nodes-base.code', 2, [col(16), -40], codeAll(
    `const state = $('Apply Decision').first().json;
const row = $input.first().json;
if (!row.batch_id) throw new Error('Batch ' + state.batch_id + ' could not be approved (its state changed while waiting). Nothing was sent.');
return state.selected.map(r => ({ json: { batch_id: state.batch_id, contact_id: r.contact_id, touch: Number(r.touch), name: r.name, token: state.config.internalToken, touch_url: state.config.touchUrl } }));`),
    { notes: 'Un ítem por contacto del lote aprobado.' })
   .add('Dispatch Touch', 'n8n-nodes-base.httpRequest', 4.2, [col(17), -40], {
    method: 'POST',
    url: '={{ $json.touch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-revival-token', value: '={{ $json.token }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ batch_id: $json.batch_id, contact_id: $json.contact_id, touch: $json.touch }) }}',
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1500 } }, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
       notes: 'Llamada INTERNA a Send Touch, de a un lead cada 1.5 s. Reintento fijo (no el bucle exponencial: ese asume 1 ítem por ejecución). 202 = aceptado, 409 = bloqueado por la guarda, 200 = duplicado.' })
   .add('Summarize Dispatch', 'n8n-nodes-base.code', 2, [col(18), -40], codeAll(
    `const state = $('Apply Decision').first().json;
const res = $input.all().map(i => i.json);
const count = c => res.filter(r => r.statusCode === c).length;
const accepted = count(202), blocked = count(409), duplicate = count(200);
const failures = res.filter(r => ![200, 202, 409].includes(r.statusCode));
return [{ json: { ...state, dispatch: { total: res.length, accepted, blocked, duplicate, failed: failures.length, failures: failures.slice(0, 5).map(f => f.error ? JSON.stringify(f.error).slice(0, 200) : 'status ' + f.statusCode) } } }];`))
   .add('Side · Finalize Batch', 'n8n-nodes-base.postgres', 2.6, [col(19), -200], {
    operation: 'executeQuery',
    query: "UPDATE revival_batches SET status = 'dispatched', summary = $2::jsonb WHERE batch_id = $1",
    options: { queryReplacement: '={{ [$json.batch_id, JSON.stringify($json.dispatch)] }}' },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 })
   .add('Send Run Summary', 'n8n-nodes-base.emailSend', 2.1, [col(19), -40], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Revival run ' + $json.batch_id + ': ' + $json.dispatch.accepted + ' accepted, ' + $json.dispatch.blocked + ' blocked, ' + $json.dispatch.failed + ' failed' }}",
    emailFormat: 'text',
    text: "={{ 'Batch ' + $json.batch_id + '\\nDispatched: ' + $json.dispatch.total + '\\nAccepted: ' + $json.dispatch.accepted + '\\nBlocked by guard: ' + $json.dispatch.blocked + '\\nDuplicates: ' + $json.dispatch.duplicate + '\\nFailed: ' + $json.dispatch.failed + ($json.dispatch.failures.length ? '\\n' + $json.dispatch.failures.join('\\n') : '') + '\\n\\nEach touch has its own execution and rows in execution_log / revival_messages.' }}",
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput' })
   .add('Capture Summary', 'n8n-nodes-base.code', 2, [col(20), -40], code(
    `const s = $('Summarize Dispatch').item.json;
const r = $input.item.json;
return { json: { ...s, run_status: 'dispatched', summary_sent: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Finish Run', 'n8n-nodes-base.code', 2, [col(21), 200], code(
    `const s = $input.item.json;
return { json: { ...s, finished_at: new Date().toISOString() } };`),
    { notes: 'Todas las rutas terminan aquí: sin candidatos, lote rechazado, sin respuesta o despachado.' });
  markIdempotency(w, {
    position: [col(22), 40], keyExpr: '$json.idem.key',
    statusExpr: "(($json.dispatch && $json.dispatch.failed > 0) || ($json.summary_sent && !$json.summary_sent.ok)) ? 'failed' : 'done'",
    resultExpr: '({ run_status: $json.run_status, batch_id: $json.batch_id })',
  });
  w.add('Assert Run', 'n8n-nodes-base.code', 2, [col(22), 200], code(
    `const s = $input.item.json;
if (s.dispatch && s.dispatch.failed > 0) throw new Error('Revival batch ' + s.batch_id + ': ' + s.dispatch.failed + ' dispatch(es) failed: ' + s.dispatch.failures.join(' | '));
if (s.summary_sent && !s.summary_sent.ok) throw new Error('Revival batch ' + s.batch_id + ' dispatched but the summary email failed: ' + s.summary_sent.error);
return { json: { batch_id: s.batch_id, run_status: s.run_status } };`),
    { notes: 'Falla ruidosamente si algún despacho o el resumen fallaron → Error Handler.' });

  // ── Log por paso (ramas laterales, encima de su nodo) ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.batch_id', ...o });
  L('Idempotency Result', { step: 'run_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'", detail: '({ trigger: $json.trigger })' });
  L('Select Candidates', { step: 'candidates_selected', detail: '({ found: $json.candidates_found, selected: $json.selected.length, skipped: $json.skipped_counts })' });
  L('Batch Created', { step: 'batch_approval_requested', status: "'waiting'", detail: '({ size: $json.selected.length })' });
  L('Apply Decision', { step: 'batch_decision', status: "$json.human.status === 'no_human_response' ? 'failed' : 'ok'", error: "$json.human.status === 'no_human_response' ? 'no response (timeout or ambiguous): batch NOT approved' : ''", detail: '({ result: $json.human.status })' });
  L('Summarize Dispatch', { step: 'dispatched', status: "$json.dispatch.failed > 0 ? 'failed' : 'ok'", error: "$json.dispatch.failures.join(' | ')", detail: '({ dispatch: $json.dispatch })' });
  L('Finish Run', { step: 'completed', status: "(($json.dispatch && $json.dispatch.failed > 0) || ($json.summary_sent && !$json.summary_sent.ok)) ? 'failed' : 'ok'", detail: '({ run_status: $json.run_status })' });

  w.note('## Revival · Daily Run\nSelecciona inactivos + toques vencidos (SQL), filtra/deduplica/aplica bajas (determinístico), pide aprobación del LOTE y despacha un Send Touch por lead.', [col(0) - 20, -250], col(9), 130)
   .note('### Log por paso → Postgres\nNodos "Log · …" y "Side · …": ramas laterales, no alteran el flujo.', [col(0) - 20, 640], 520, 90);

  // ── Conexiones ──
  w.link('Daily Schedule', 'Prepare Run').link('Manual Trigger (webhook)', 'Prepare Run').link('Prepare Run', 'Claim Idempotency')
   .link('New run?', 'Load Suppression', 0).link('New run?', 'Skip (already ran)', 1)
   .link('Load Suppression', 'Load Candidates').link('Load Candidates', 'Select Candidates').link('Select Candidates', 'Any candidates?')
   .link('Any candidates?', 'Create Batch', 0).link('Any candidates?', 'No Candidates', 1)
   .link('No Candidates', 'Finish Run')
   .link('Create Batch', 'Batch Created').link('Batch Created', 'Build Preview').link('Build Preview', 'Request Batch Approval')
   .link('Request Batch Approval', 'Apply Decision').link('Apply Decision', 'Batch Approved?')
   .link('Batch Approved?', 'Approve Batch', 0).link('Batch Approved?', 'Reject Batch', 1)
   .link('Reject Batch', 'Batch Rejected').link('Batch Rejected', 'Finish Run')
   .link('Approve Batch', 'Expand Batch').link('Expand Batch', 'Dispatch Touch').link('Dispatch Touch', 'Summarize Dispatch')
   .link('Summarize Dispatch', 'Send Run Summary').link('Summarize Dispatch', 'Side · Finalize Batch')
   .link('Send Run Summary', 'Capture Summary').link('Capture Summary', 'Finish Run')
   .link('Finish Run', 'Mark Idempotency').link('Finish Run', 'Assert Run');

  return { file: 'revival-run.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
