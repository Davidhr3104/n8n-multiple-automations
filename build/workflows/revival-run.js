const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg, idempotency, markIdempotency } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-run';
const col = n => n * 240;

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
    { notes: 'Config del revival (edítala en build/workflows/revival-config.js): inactividad, tope por corrida, toques, espaciado, horario de envío, modos.' });

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
    { notes: 'keys = lista de bajas completa (se vuelve a consultar al preparar y al enviar). engaged = email/teléfono de quienes YA tienen secuencia: un duplicado suyo no recibe primer toque.' });
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

  // ── Lote: se PREPARAN los borradores reales (nada se envía) ──
  pg(w, 'Create Batch', [col(9), 120],
    `INSERT INTO revival_batches (batch_id, status, size, execution_id, review_token, expires_at)
VALUES ($1, 'preparing', $2::int, $3, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(hours => $4::int))
RETURNING batch_id, review_token, expires_at`,
    '[$json.batch_id, $json.selected.length, $execution.id, $json.config.approvalTimeoutHours]',
    { notes: 'El lote nace "preparing" con un token aleatorio de revisión y fecha de vencimiento. Mientras no esté "approved" no puede salir ningún mensaje.' });
  w.add('Batch Created', 'n8n-nodes-base.code', 2, [col(10), 120], code(
    `const r = $input.item.json;
return { json: { ...$('Any candidates?').item.json, review_token: r.review_token, expires_at: r.expires_at } };`))
   .add('Expand Batch', 'n8n-nodes-base.code', 2, [col(11), 120], codeAll(
    `const s = $('Batch Created').first().json;
return s.selected.map(r => ({ json: { batch_id: s.batch_id, contact_id: r.contact_id, touch: Number(r.touch), kind: r.kind, token: s.config.internalToken, prepare_url: s.config.prepareUrl } }));`),
    { notes: 'Un ítem por contacto seleccionado.' })
   .add('Prepare Draft', 'n8n-nodes-base.httpRequest', 4.2, [col(12), 120], {
    method: 'POST',
    url: '={{ $json.prepare_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-revival-token', value: '={{ $json.token }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ batch_id: $json.batch_id, contact_id: $json.contact_id, touch: $json.touch, kind: $json.kind }) }}',
    options: { timeout: 150000, batching: { batch: { batchSize: 1, batchInterval: 500 } }, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput',
       notes: 'Llamada INTERNA y SÍNCRONA a Prepare Draft: responde cuando el borrador (o su bloqueo) ya está guardado. NO envía nada.' })
   .add('Summarize Preparation', 'n8n-nodes-base.code', 2, [col(13), 120], codeAll(
    `const state = $('Batch Created').first().json;
const res = $input.all().map(i => i.json);
const st = r => (r.body && r.body.status) || null;
const ready = res.filter(r => r.statusCode === 200 && st(r) === 'pending_review').length;
const blocked = res.filter(r => r.statusCode === 200 && st(r) === 'blocked').length;
const failed = res.filter(r => r.statusCode === 200 && st(r) === 'failed').length;
const duplicate = res.filter(r => r.statusCode === 200 && st(r) === 'duplicate').length;
const guard_blocked = res.filter(r => r.statusCode === 409).length;
const errors = res.filter(r => ![200, 409].includes(r.statusCode));
return [{ json: { ...state, prep: { total: res.length, ready, blocked, failed, duplicate, guard_blocked, errors: errors.length, error_samples: errors.slice(0, 5).map(f => f.error ? JSON.stringify(f.error).slice(0, 200) : 'status ' + f.statusCode) } } }];`))
   .add('Any ready?', 'n8n-nodes-base.if', 2.2, [col(14), 120], ifBool('={{ $json.prep.ready > 0 }}'));

  // ── Sin borradores listos: el lote se cierra, no hay nada que revisar ──
  pg(w, 'Reject Batch', [col(15), 420],
    "UPDATE revival_batches SET status = 'rejected', decided_at = now(), summary = $2::jsonb WHERE batch_id = $1 AND status = 'preparing' RETURNING batch_id",
    '[$json.batch_id, JSON.stringify($json.prep)]', { alwaysOutputData: true });
  w.add('Nothing To Review', 'n8n-nodes-base.code', 2, [col(16), 420], code(
    `return { json: { ...$('Summarize Preparation').item.json, run_status: 'nothing_to_review' } };`));

  // ── Hay borradores: el dueño recibe el link de revisión ──
  pg(w, 'Mark Pending Review', [col(15), 0],
    "UPDATE revival_batches SET status = 'pending_review', summary = $2::jsonb WHERE batch_id = $1 AND status = 'preparing' RETURNING batch_id",
    '[$json.batch_id, JSON.stringify($json.prep)]', { alwaysOutputData: true, notes: 'Solo pasa a pending_review si seguía "preparing".' });
  w.add('Review Marked', 'n8n-nodes-base.code', 2, [col(16), 0], code(
    `const s = $('Summarize Preparation').item.json;
if (!$input.item.json.batch_id) throw new Error('Batch ' + s.batch_id + ' could not move to pending_review (its state changed). No review link was sent.');
const link = s.config.publicBaseUrl + '/webhook/revival-review?batch=' + encodeURIComponent(s.batch_id) + '&token=' + encodeURIComponent(s.review_token);
const lines = [
  'Revival batch ' + s.batch_id + ' is ready to review.',
  s.prep.ready + ' message(s) wait for your decision: send, edit or skip each one.',
  s.prep.blocked + s.prep.failed > 0 ? (s.prep.blocked + s.prep.failed) + ' contact(s) were blocked or failed and will not be messaged.' : '',
  '',
  'Review: ' + link,
  'This link expires ' + s.expires_at + '. Nothing is sent until you submit.',
].filter(l => l !== '');
const html = '<p>Revival batch <b>' + s.batch_id + '</b> is ready to review.</p><p><b>' + s.prep.ready + '</b> message(s) wait for your decision: send, edit or skip each one.' + (s.prep.blocked + s.prep.failed > 0 ? ' ' + (s.prep.blocked + s.prep.failed) + ' contact(s) were blocked or failed and will not be messaged.' : '') + '</p><p><a href="' + link + '" style="display:inline-block;padding:12px 22px;background:#1e40af;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700">Review messages</a></p><p style="color:#555">This link expires ' + s.expires_at + '. Nothing is sent until you submit.</p>';
return { json: { ...s, review_link: link, email_text: lines.join('\\n'), email_html: html } };`))
   .add('Send Review Email', 'n8n-nodes-base.emailSend', 2.1, [col(17), 0], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Review revival batch (' + $json.prep.ready + ' messages)' }}",
    emailFormat: 'both',
    text: '={{ $json.email_text }}',
    html: '={{ $json.email_html }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aprobación humana ANTES de cualquier envío, ahora sobre los mensajes REALES. Canal: email con link (Mailpit local). Para Slack, enviar este mismo link por Slack.' })
   .add('Capture Review Email', 'n8n-nodes-base.code', 2, [col(18), 0], code(
    `const s = $('Review Marked').item.json;
const r = $input.item.json;
return { json: { ...s, run_status: 'awaiting_review', review_email: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Cierre común ──
  w.add('Finish Run', 'n8n-nodes-base.code', 2, [col(19), 200], code(
    `const s = $input.item.json;
return { json: { ...s, finished_at: new Date().toISOString() } };`),
    { notes: 'Todas las rutas terminan aquí: sin candidatos, sin borradores o esperando la revisión del dueño.' });
  markIdempotency(w, {
    position: [col(20), 40], keyExpr: '$json.idem.key',
    statusExpr: "(($json.prep && $json.prep.errors > 0) || ($json.review_email && !$json.review_email.ok)) ? 'failed' : 'done'",
    resultExpr: '({ run_status: $json.run_status, batch_id: $json.batch_id })',
  });
  w.add('Assert Run', 'n8n-nodes-base.code', 2, [col(20), 200], code(
    `const s = $input.item.json;
if (s.prep && s.prep.errors > 0) throw new Error('Revival batch ' + s.batch_id + ': ' + s.prep.errors + ' draft preparation(s) failed: ' + s.prep.error_samples.join(' | '));
if (s.review_email && !s.review_email.ok) throw new Error('Revival batch ' + s.batch_id + ' prepared but the review email failed: ' + s.review_email.error);
return { json: { batch_id: s.batch_id, run_status: s.run_status } };`),
    { notes: 'Falla ruidosamente si algún borrador no se pudo preparar o si el email de revisión no salió.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.batch_id', ...o });
  L('Idempotency Result', { step: 'run_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'", detail: '({ trigger: $json.trigger })' });
  L('Select Candidates', { step: 'candidates_selected', detail: '({ found: $json.candidates_found, selected: $json.selected.length, skipped: $json.skipped_counts })' });
  L('Batch Created', { step: 'batch_created', detail: '({ size: $json.selected.length, expires_at: $json.expires_at })' });
  L('Summarize Preparation', { step: 'drafts_prepared', status: "$json.prep.errors > 0 ? 'failed' : 'ok'", error: "$json.prep.error_samples.join(' | ')", detail: '({ prep: $json.prep })' });
  L('Capture Review Email', { step: 'review_requested', status: "$json.review_email.ok ? 'waiting' : 'failed'", error: "$json.review_email.error ?? ''", detail: '({ ready: $json.prep.ready })' });
  L('Finish Run', { step: 'completed', status: "(($json.prep && $json.prep.errors > 0) || ($json.review_email && !$json.review_email.ok)) ? 'failed' : 'ok'", detail: '({ run_status: $json.run_status })' });

  w.note('## Revival · Daily Run\nSelects inactive contacts + due follow-ups (SQL), filters/dedupes/applies opt-outs (deterministic), PREPARES the real drafts and emails the owner a review link. Nothing is sent here.', [col(0) - 20, -250], col(9), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …" and "Side · …": side branches, they do not alter the flow.', [col(0) - 20, 660], 520, 90);

  // ── Conexiones ──
  w.link('Daily Schedule', 'Prepare Run').link('Manual Trigger (webhook)', 'Prepare Run').link('Prepare Run', 'Claim Idempotency')
   .link('New run?', 'Load Suppression', 0).link('New run?', 'Skip (already ran)', 1)
   .link('Load Suppression', 'Load Candidates').link('Load Candidates', 'Select Candidates').link('Select Candidates', 'Any candidates?')
   .link('Any candidates?', 'Create Batch', 0).link('Any candidates?', 'No Candidates', 1)
   .link('No Candidates', 'Finish Run')
   .link('Create Batch', 'Batch Created').link('Batch Created', 'Expand Batch').link('Expand Batch', 'Prepare Draft')
   .link('Prepare Draft', 'Summarize Preparation').link('Summarize Preparation', 'Any ready?')
   .link('Any ready?', 'Mark Pending Review', 0).link('Any ready?', 'Reject Batch', 1)
   .link('Reject Batch', 'Nothing To Review').link('Nothing To Review', 'Finish Run')
   .link('Mark Pending Review', 'Review Marked').link('Review Marked', 'Send Review Email').link('Send Review Email', 'Capture Review Email')
   .link('Capture Review Email', 'Finish Run')
   .link('Finish Run', 'Mark Idempotency').link('Finish Run', 'Assert Run');

  return { file: 'revival-run.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
