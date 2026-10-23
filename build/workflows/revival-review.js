const { Workflow, embed, CRED, uid, code, codeAll, ifBool, logBranch, pg, respond } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-review';
const col = n => n * 240;

// Cabeceras de la página: sin scripts, sin recursos externos, sin caché, formularios solo hacia este mismo origen.
const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Content-Security-Policy', value: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  { name: 'Cache-Control', value: 'no-store' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] };

function respondHtml(w, name, position) {
  return w.add(name, 'n8n-nodes-base.respondToWebhook', 1.4, position,
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.http_status || 200 }}', responseHeaders: HTML_HEADERS } });
}

const LOAD_REVIEW_SQL = `SELECT b.batch_id, b.status, b.expires_at, (b.expires_at < now()) AS expired, now() AS now_utc,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'contact_id', d.contact_id, 'contact_name', c.name, 'email', c.email, 'company', c.company, 'phone', c.phone,
      'timezone', c.timezone, 'touch', d.touch, 'kind', d.kind, 'status', d.status, 'body_core', d.body_core, 'blocked_reason', d.reason
    ) ORDER BY d.id)
    FROM revival_drafts d JOIN revival_contacts c ON c.contact_id = d.contact_id WHERE d.batch_id = b.batch_id), '[]'::jsonb) AS drafts
FROM revival_batches b
WHERE b.batch_id = $1 AND b.review_token = $2`;

module.exports = function revivalReview() {
  const w = Workflow('revivalreview001', 'Revival · Review Page (Auditable)');

  // ════════ GET: mostrar la revisión ════════
  w.add('Review Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 100],
    { httpMethod: 'GET', path: 'revival-review', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'El dueño llega aquí desde el link del email (?batch=…&token=…). Sin token válido no se muestra nada.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 100],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Query', 'n8n-nodes-base.code', 2, [col(2), 100], code(
    `const item = $input.item.json;
const q = item.query || {};
const ok = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
return { json: { batch: ok(q.batch) ? q.batch : '', token: ok(q.token) ? q.token : '', config: item.config } };`))
   .add('Query Valid?', 'n8n-nodes-base.if', 2.2, [col(3), 100], ifBool('={{ !!$json.batch && !!$json.token }}'))
   .add('Render Invalid', 'n8n-nodes-base.code', 2, [col(4), 300], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }],
    `return { json: { html: renderMessagePage({ title: 'Link not valid', message: 'This review link is missing information. Open the link from the email again.' }), http_status: 400 } };`)));

  pg(w, 'Load Review Data', [col(4), 100], LOAD_REVIEW_SQL, '[$json.batch, $json.token]', { alwaysOutputData: true });
  w.add('Render Review', 'n8n-nodes-base.code', 2, [col(5), 100], code(embed(
    [{ file: 'review', exports: ['renderReviewPage', 'renderMessagePage'] }, { file: 'schedule', exports: ['sendNote', 'inferTimezone'] }],
    `const s = $('Parse Query').item.json;
const r = $input.item.json;
const cfg = s.config;
if (!r.batch_id) return { json: { ...s, html: renderMessagePage({ title: 'Link not valid', message: 'This review link is not valid.' }), http_status: 403, outcome: 'invalid_token' } };
if (r.expired) return { json: { ...s, html: renderMessagePage({ title: 'Link expired', message: 'This batch was not reviewed in time, so nothing was sent. The contacts will be prepared again in the next run.' }), http_status: 410, outcome: 'expired' } };
if (r.status !== 'pending_review') return { json: { ...s, html: renderMessagePage({ title: 'Already reviewed', message: 'This batch has already been submitted (status: ' + r.status + ').' }), http_status: 409, outcome: 'not_pending' } };
const drafts = r.drafts.map(d => ({ ...d, status: d.status, send_note: d.status === 'pending_review' ? sendNote(r.now_utc, inferTimezone({ timezone: d.timezone, phone: d.phone }, cfg), cfg.sendWindow) : null }));
const html = renderReviewPage({ batch: { batch_id: r.batch_id, token: s.token, size: drafts.length, expires_at: r.expires_at }, drafts, submitUrl: '/webhook/revival-review-submit', dataLabel: cfg.dataLabel });
return { json: { ...s, html, http_status: 200, outcome: 'shown', drafts_count: drafts.length } };`)),
    { notes: 'Todo dato de CRM/lead se escapa en el render. La nota de horario dice si cada mensaje sale ya o se retiene hasta la próxima ventana.' });
  respondHtml(w, 'Respond Page', [col(6), 100]);

  // ════════ POST: recibir las decisiones ════════
  w.add('Submit Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 560],
    { httpMethod: 'POST', path: 'revival-review-submit', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Recibe el formulario de la página de revisión (application/x-www-form-urlencoded).' })
   .add('Config (submit)', 'n8n-nodes-base.set', 3.4, [col(1), 560],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: REVIVAL }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Submit', 'n8n-nodes-base.code', 2, [col(2), 560], code(
    `const item = $input.item.json;
const body = item.body || {};
const ok = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
return { json: { form: body, batch: ok(body.batch) ? body.batch : '', token: ok(body.token) ? body.token : '', config: item.config } };`))
   .add('Submit Valid?', 'n8n-nodes-base.if', 2.2, [col(3), 560], ifBool('={{ !!$json.batch && !!$json.token }}'))
   .add('Render Invalid Submit', 'n8n-nodes-base.code', 2, [col(4), 760], code(embed(
    [{ file: 'review', exports: ['renderMessagePage'] }],
    `return { json: { html: renderMessagePage({ title: 'Submission not valid', message: 'The form is missing information. Nothing was sent.' }), http_status: 400 } };`)));

  pg(w, 'Load Review Data (submit)', [col(4), 560], LOAD_REVIEW_SQL, '[$json.batch, $json.token]', { alwaysOutputData: true });
  w.add('Apply Review', 'n8n-nodes-base.code', 2, [col(5), 560], code(embed(
    [{ file: 'review', exports: ['applyReview', 'renderMessagePage'] }, { file: 'revival', exports: ['finalizeMessage'] }],
    `const s = $('Parse Submit').item.json;
const r = $input.item.json;
const fail = (title, message, status, outcome) => ({ json: { ...s, can_apply: false, html: renderMessagePage({ title, message }), http_status: status, outcome } });
if (!r.batch_id) return fail('Submission not valid', 'The link or token is not valid. Nothing was sent.', 403, 'invalid_token');
if (r.expired) return fail('Link expired', 'This batch was not reviewed in time. Nothing was sent.', 410, 'expired');
if (r.status !== 'pending_review') return fail('Already reviewed', 'This batch was already submitted (status: ' + r.status + '). Nothing changed.', 409, 'not_pending');
const { decisions, summary } = applyReview(r.drafts, s.form, finalizeMessage);
return { json: { ...s, can_apply: true, batch_id: r.batch_id, decisions, summary } };`)),
    { notes: 'DETERMINÍSTICO y fail-closed: sin elección clara = no se envía. Un texto editado con links o promesas de precio se salta con su motivo; el pie de baja se agrega siempre.' })
   .add('Can Apply?', 'n8n-nodes-base.if', 2.2, [col(6), 560], ifBool('={{ $json.can_apply }}'));
  respondHtml(w, 'Respond Page (submit)', [col(7), 760]);

  pg(w, 'Persist Review', [col(7), 560],
    `WITH b AS (
  UPDATE revival_batches SET status = 'approved', decided_at = now()
  WHERE batch_id = $1 AND review_token = $2 AND status = 'pending_review' AND expires_at > now() RETURNING batch_id
), d AS (
  UPDATE revival_drafts d SET status = x.status, body_core = x.body_core, body = x.body, edited = x.edited, reason = x.reason, decided_at = now()
  FROM jsonb_to_recordset($3::jsonb) AS x(id bigint, status text, body_core text, body text, edited boolean, reason text)
  WHERE d.id = x.id AND d.batch_id = $1 AND d.status = 'pending_review' AND EXISTS (SELECT 1 FROM b)
  RETURNING d.id, d.status
)
SELECT (SELECT count(*) FROM b) AS batch_updated, (SELECT count(*) FROM d) AS drafts_updated, $4::jsonb AS state`,
    '[$json.batch, $json.token, JSON.stringify($json.decisions.map(d => ({ id: d.id, status: d.status, body_core: d.body_core, body: d.body, edited: d.edited, reason: d.reason }))), JSON.stringify($json)]',
    { notes: 'UNA sentencia atómica: el lote pasa a approved SOLO si seguía pending_review y no vencido; un doble envío del formulario no duplica nada.' });
  w.add('Review Persisted', 'n8n-nodes-base.code', 2, [col(8), 560], code(embed(
    [{ file: 'review', exports: ['renderMessagePage', 'renderResultPage'] }],
    `const r = $input.item.json;
const s = r.state;
if (Number(r.batch_updated) !== 1) return { json: { ...s, applied: false, html: renderMessagePage({ title: 'Already reviewed', message: 'This batch was already submitted or has expired. Nothing changed.' }), http_status: 409, outcome: 'race' } };
if (Number(r.drafts_updated) !== s.decisions.length) throw new Error('Review persisted ' + r.drafts_updated + ' drafts but ' + s.decisions.length + ' decisions were expected for batch ' + s.batch_id);
return { json: { ...s, applied: true, html: renderResultPage(s.summary, s.config.dataLabel), http_status: 200, outcome: 'submitted', approved_ids: s.decisions.filter(d => d.status === 'approved').map(d => d.id) } };`)))
   .add('Applied?', 'n8n-nodes-base.if', 2.2, [col(9), 560], ifBool('={{ $json.applied }}'));
  respondHtml(w, 'Respond Result', [col(10), 460]);
  respondHtml(w, 'Respond Page (race)', [col(10), 760]);

  // ── Después de responder al navegador: despachar el envío de cada borrador aprobado ──
  w.add('Expand Approved', 'n8n-nodes-base.code', 2, [col(11), 460], codeAll(
    `const s = $('Review Persisted').first().json;
return (s.approved_ids || []).map(id => ({ json: { draft_id: id, token: s.config.internalToken, touch_url: s.config.touchUrl } }));`),
    { notes: 'Un ítem por borrador aprobado. Send Touch re-comprueba TODO antes de enviar (lote aprobado, bajas, orden, horario).' })
   .add('Dispatch Send', 'n8n-nodes-base.httpRequest', 4.2, [col(12), 460], {
    method: 'POST',
    url: '={{ $json.touch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-revival-token', value: '={{ $json.token }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ draft_id: $json.draft_id }) }}',
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
       notes: 'Llamada INTERNA, de a un borrador por segundo. 202 = aceptado o diferido por horario, 409 = bloqueado por la guarda, 200 = duplicado.' })
   .add('Summarize Dispatch', 'n8n-nodes-base.code', 2, [col(13), 460], codeAll(
    `const s = $('Review Persisted').first().json;
const res = $input.all().map(i => i.json);
const count = c => res.filter(r => r.statusCode === c).length;
const failures = res.filter(r => ![200, 202, 409].includes(r.statusCode));
return [{ json: { ...s, dispatch: { total: res.length, accepted: count(202), blocked: count(409), duplicate: count(200), failed: failures.length, failures: failures.slice(0, 5).map(f => f.error ? JSON.stringify(f.error).slice(0, 200) : 'status ' + f.statusCode) } } }];`))
   .add('Assert Dispatch', 'n8n-nodes-base.code', 2, [col(14), 460], code(
    `const s = $input.item.json;
if (s.dispatch.failed > 0) throw new Error('Review of batch ' + s.batch_id + ': ' + s.dispatch.failed + ' send dispatch(es) failed: ' + s.dispatch.failures.join(' | ') + '. The approved drafts stay approved; the send queue will retry them.');
return { json: { batch_id: s.batch_id, dispatch: s.dispatch } };`),
    { notes: 'Si algún despacho falla, el borrador sigue aprobado y la cola de envío (Send Queue) lo reintenta; además salta la alerta.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.batch', ...o });
  L('Render Review', { step: 'review_page_shown', status: "$json.outcome === 'shown' ? 'ok' : 'skipped'", error: "$json.outcome === 'shown' ? '' : $json.outcome", detail: '({ drafts: $json.drafts_count ?? 0 })' });
  L('Apply Review', { step: 'review_evaluated', status: "$json.can_apply ? 'ok' : 'skipped'", error: "$json.can_apply ? '' : $json.outcome", detail: '({ summary: $json.summary ?? null })' });
  L('Review Persisted', { step: 'review_submitted', status: "$json.applied ? 'ok' : 'skipped'", error: "$json.applied ? '' : $json.outcome", detail: '({ approved: $json.summary.approved, skipped: $json.summary.skipped, edited: $json.summary.edited, rejected_edits: $json.summary.rejected_edits.length })' });
  L('Summarize Dispatch', { step: 'send_dispatched', status: "$json.dispatch.failed > 0 ? 'failed' : 'ok'", error: "$json.dispatch.failures.join(' | ')", detail: '({ dispatch: $json.dispatch })' });

  w.note('## Revival · Review Page\nThe owner opens the link from the email, sees the REAL drafts, and for each lead can send, edit or skip. Only what is explicitly sent is dispatched. Expired or reused links change nothing.', [col(0) - 20, -250], col(8), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 960], 400, 90);

  w.link('Review Webhook', 'Config').link('Config', 'Parse Query').link('Parse Query', 'Query Valid?')
   .link('Query Valid?', 'Load Review Data', 0).link('Query Valid?', 'Render Invalid', 1)
   .link('Load Review Data', 'Render Review').link('Render Review', 'Respond Page').link('Render Invalid', 'Respond Page')
   .link('Submit Webhook', 'Config (submit)').link('Config (submit)', 'Parse Submit').link('Parse Submit', 'Submit Valid?')
   .link('Submit Valid?', 'Load Review Data (submit)', 0).link('Submit Valid?', 'Render Invalid Submit', 1)
   .link('Render Invalid Submit', 'Respond Page (submit)')
   .link('Load Review Data (submit)', 'Apply Review').link('Apply Review', 'Can Apply?')
   .link('Can Apply?', 'Persist Review', 0).link('Can Apply?', 'Respond Page (submit)', 1)
   .link('Persist Review', 'Review Persisted').link('Review Persisted', 'Applied?')
   .link('Applied?', 'Respond Result', 0).link('Applied?', 'Respond Page (race)', 1)
   .link('Respond Result', 'Expand Approved').link('Expand Approved', 'Dispatch Send').link('Dispatch Send', 'Summarize Dispatch').link('Summarize Dispatch', 'Assert Dispatch');

  return { file: 'revival-review.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
