const { Workflow, embed, uid, code, codeAll, logBranch, pg } = require('../foundation');
const { QUALIFIER } = require('./qualifier-config');

const WF = 'qualifier-stale';
const col = n => n * 240;

module.exports = function qualifierStale() {
  const w = Workflow('qualifierstale01', 'Qualifier · Stale & Queue (Auditable)');

  w.add('Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] } },
    { notes: 'Cada 15 minutos: (1) conversaciones frías → seguimiento a las 24 h / stale a las 72 h, (2) libera los mensajes de la cola cuyo horario ya abrió.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'qualifier-stale', responseMode: 'onReceived', options: {} }, { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/qualifier-stale.' })
   .add('Prepare Run', 'n8n-nodes-base.code', 2, [col(1), 200], code(`return { json: { config: ${JSON.stringify(QUALIFIER)} } };`));

  // ── 1) Conversaciones frías ──
  pg(w, 'Find Quiet Conversations', [col(2), 200],
    `SELECT contact_id, name, phone, email, status, last_inbound_at, last_outbound_at, followup_sent_at,
  COALESCE((SELECT body FROM messages_log m WHERE m.contact_id = s.contact_id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1), '') AS last_lead_text
FROM conversation_state s
WHERE s.status = 'active' AND s.last_outbound_at IS NOT NULL AND s.last_outbound_at < now() - make_interval(hours => $1::int)
ORDER BY s.last_outbound_at LIMIT 50`,
    '[$json.config.followUpHours]', { alwaysOutputData: true, notes: 'Candidatas: activas cuyo último mensaje del bot tiene más de 24 h. La decisión exacta la toma el código (staleAction).' });
  w.add('Classify', 'n8n-nodes-base.code', 2, [col(3), 200], codeAll(embed(
    [{ file: 'qualifier', exports: ['staleAction', 'followUpMessage', 'isSpanish', 'validateOutbound'] }],
    `const cfg = $('Prepare Run').first().json.config;
const now = new Date().toISOString();
const rows = $input.all().map(i => i.json).filter(r => r.contact_id);
const followups = [];
const stale = [];
for (const r of rows) {
  const a = staleAction(r, now, { followUp: cfg.followUpHours, stale: cfg.staleHours }).action;
  if (a === 'stale') stale.push(r.contact_id);
  else if (a === 'followup') {
    const body = followUpMessage(r.name, isSpanish(r.last_lead_text) ? 'es' : 'en');
    if (validateOutbound(body).ok) followups.push({ contact_id: r.contact_id, body });
  }
}
return [{ json: { config: cfg, found: rows.length, followups, stale } }];`)),
    { notes: 'DETERMINÍSTICO: 24 h sin respuesta → un solo seguimiento; 72 h → stale. La IA no participa.' });
  pg(w, 'Apply Stale Actions', [col(4), 200],
    `WITH f AS (
  INSERT INTO qualifier_outbox (contact_id, kind, body, execution_id)
  SELECT x.contact_id, 'followup', x.body, $3 FROM jsonb_to_recordset($1::jsonb) AS x(contact_id text, body text)
  WHERE NOT EXISTS (SELECT 1 FROM qualifier_outbox o WHERE o.contact_id = x.contact_id AND o.kind = 'followup' AND o.status IN ('pending', 'sent'))
  RETURNING id
), s AS (
  UPDATE conversation_state SET status = 'stale', updated_at = now()
  WHERE status = 'active' AND contact_id IN (SELECT jsonb_array_elements_text($2::jsonb)) RETURNING contact_id, name, email, phone, last_inbound_at, last_outbound_at
), rc AS (
  INSERT INTO revival_contacts (contact_id, name, email, phone, last_activity_at, history)
  SELECT contact_id, COALESCE(name, 'Unknown'), email, phone, COALESCE(last_inbound_at, last_outbound_at),
    '[{"type":"note","text":"Conversation went cold after the qualifier follow-up"}]'::jsonb FROM s
  ON CONFLICT (contact_id) DO NOTHING RETURNING contact_id
)
SELECT (SELECT count(*) FROM f) AS followups_queued, (SELECT count(*) FROM s) AS marked_stale, (SELECT count(*) FROM rc) AS added_to_revival`,
    '[JSON.stringify($json.followups), JSON.stringify($json.stale), $execution.id]',
    { notes: 'Seguimientos a la cola de salida (sin duplicar), marca stale y pasa esos contactos a la tabla de candidatos de Lead Revival.' });
  w.add('Stale Applied', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Classify').item.json;
return { json: { ...s, applied: $input.item.json } };`));

  // ── 2) Cola de salida: mensajes pendientes cuyo horario ya abrió ──
  pg(w, 'Find Due Messages', [col(6), 200],
    `SELECT id AS outbox_id FROM qualifier_outbox
WHERE status = 'pending' AND send_after <= now() AND (created_at < now() - interval '1 minute' OR kind = 'followup')
ORDER BY id LIMIT 25`, null,
    { alwaysOutputData: true, notes: 'Pendientes cuyo send_after ya pasó (fuera de horario o red de seguridad por si un envío no se despachó). Los seguimientos (creados por este mismo flujo) salen en la misma corrida. Send Message vuelve a comprobar bajas y horario.' });
  w.add('Expand Due', 'n8n-nodes-base.code', 2, [col(7), 200], codeAll(
    `const cfg = $('Prepare Run').first().json.config;
return $input.all().map(i => i.json).filter(r => r.outbox_id).map(r => ({ json: { outbox_id: Number(r.outbox_id), token: cfg.internalToken, send_url: cfg.sendUrl } }));`),
    { notes: 'Sin nada pendiente no devuelve ítems: el flujo termina sin ruido.' })
   .add('Dispatch Send', 'n8n-nodes-base.httpRequest', 4.2, [col(8), 200], {
    method: 'POST',
    url: '={{ $json.send_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-qualifier-token', value: '={{ $json.token }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ outbox_id: $json.outbox_id }) }}',
    options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 })
   .add('Summarize Dispatch', 'n8n-nodes-base.code', 2, [col(9), 200], codeAll(
    `const res = $input.all().map(i => i.json);
const count = c => res.filter(r => r.statusCode === c).length;
const failures = res.filter(r => ![200, 202, 409].includes(r.statusCode));
return [{ json: { dispatch: { total: res.length, accepted_or_deferred: count(202), blocked: count(409), duplicate: count(200), failed: failures.length, failures: failures.slice(0, 5).map(f => f.error ? JSON.stringify(f.error).slice(0, 200) : 'status ' + f.statusCode) } } }];`))
   .add('Assert Dispatch', 'n8n-nodes-base.code', 2, [col(10), 200], code(
    `const s = $input.item.json;
if (s.dispatch.failed > 0) throw new Error('Qualifier queue: ' + s.dispatch.failed + ' dispatch(es) failed: ' + s.dispatch.failures.join(' | ') + '. They stay pending and will be retried.');
return { json: s };`));

  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$execution.id', ...o });
  L('Stale Applied', { step: 'stale_processed', detail: '({ found: $json.found, followups_queued: $json.applied.followups_queued, marked_stale: $json.applied.marked_stale, added_to_revival: $json.applied.added_to_revival })' });
  L('Summarize Dispatch', { step: 'queue_dispatched', status: "$json.dispatch.failed > 0 ? 'failed' : 'ok'", error: "$json.dispatch.failures.join(' | ')", detail: '({ dispatch: $json.dispatch })' });

  w.note('## Qualifier · Stale & Queue\nEvery 15 min. (1) No reply after 24 h: one follow-up; after 72 h: the conversation is marked stale and the contact becomes a Lead Revival candidate. (2) Releases queued messages whose sending window has opened.', [col(0) - 20, -250], col(10), 120);

  w.link('Schedule', 'Prepare Run').link('Manual Trigger (webhook)', 'Prepare Run')
   .link('Prepare Run', 'Find Quiet Conversations').link('Find Quiet Conversations', 'Classify').link('Classify', 'Apply Stale Actions')
   .link('Apply Stale Actions', 'Stale Applied').link('Stale Applied', 'Find Due Messages')
   .link('Find Due Messages', 'Expand Due').link('Expand Due', 'Dispatch Send')
   .link('Dispatch Send', 'Summarize Dispatch').link('Summarize Dispatch', 'Assert Dispatch');

  return { file: 'qualifier-stale.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
