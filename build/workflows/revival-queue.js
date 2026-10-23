const { Workflow, uid, code, codeAll, logBranch, pg } = require('../foundation');
const { REVIVAL } = require('./revival-config');

const WF = 'revival-queue';
const col = n => n * 240;

module.exports = function revivalQueue() {
  const w = Workflow('revivalqueue0001', 'Revival · Send Queue (Auditable)');

  w.add('Queue Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] } },
    { notes: 'Cada 15 minutos. Libera los borradores diferidos cuyo horario ya abrió y reintenta los aprobados que nunca se despacharon.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'revival-queue', responseMode: 'onReceived', options: {} }, { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/revival-queue.' })
   .add('Prepare Run', 'n8n-nodes-base.code', 2, [col(1), 200], code(`return { json: { config: ${JSON.stringify(REVIVAL)} } };`));

  pg(w, 'Find Due', [col(2), 200],
    `SELECT d.id AS draft_id
FROM revival_drafts d JOIN revival_batches b ON b.batch_id = d.batch_id
WHERE b.status = 'approved'
  AND ((d.status = 'deferred' AND d.send_after <= now()) OR (d.status = 'approved' AND d.decided_at < now() - interval '5 minutes'))
ORDER BY d.id LIMIT 25`, null,
    { alwaysOutputData: true, notes: 'deferred: su ventana horaria ya abrió. approved con más de 5 min: red de seguridad por si el despacho original falló.' });
  w.add('Expand Due', 'n8n-nodes-base.code', 2, [col(3), 200], codeAll(
    `const cfg = $('Prepare Run').first().json.config;
return $input.all().map(i => i.json).filter(r => r.draft_id).map(r => ({ json: { draft_id: Number(r.draft_id), token: cfg.internalToken, touch_url: cfg.touchUrl } }));`),
    { notes: 'Sin nada pendiente no devuelve ítems: el flujo termina sin ruido en el log.' })
   .add('Dispatch Send', 'n8n-nodes-base.httpRequest', 4.2, [col(4), 200], {
    method: 'POST',
    url: '={{ $json.touch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-revival-token', value: '={{ $json.token }}' }, { name: 'content-type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ draft_id: $json.draft_id }) }}',
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1000 } }, response: { response: { fullResponse: true, neverError: true } } },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
       notes: 'Send Touch vuelve a comprobar TODO (guarda, bajas, orden y horario) antes de enviar; aquí solo se le avisa.' })
   .add('Summarize Dispatch', 'n8n-nodes-base.code', 2, [col(5), 200], codeAll(
    `const res = $input.all().map(i => i.json);
const count = c => res.filter(r => r.statusCode === c).length;
const failures = res.filter(r => ![200, 202, 409].includes(r.statusCode));
return [{ json: { dispatch: { total: res.length, accepted_or_deferred: count(202), blocked: count(409), duplicate: count(200), failed: failures.length, failures: failures.slice(0, 5).map(f => f.error ? JSON.stringify(f.error).slice(0, 200) : 'status ' + f.statusCode) } } }];`))
   .add('Assert Dispatch', 'n8n-nodes-base.code', 2, [col(6), 200], code(
    `const s = $input.item.json;
if (s.dispatch.failed > 0) throw new Error('Send queue: ' + s.dispatch.failed + ' dispatch(es) failed: ' + s.dispatch.failures.join(' | ') + '. They stay queued and will be retried.');
return { json: s };`));

  logBranch(w, 'Summarize Dispatch', { workflow: WF, step: 'queue_dispatched', entity: '$execution.id', status: "$json.dispatch.failed > 0 ? 'failed' : 'ok'", error: "$json.dispatch.failures.join(' | ')", detail: '({ dispatch: $json.dispatch })' });

  w.note('## Revival · Send Queue\nEvery 15 min: sends the drafts that were held outside the contact\'s sending hours once their window opens. Each send is re-checked by Send Touch.', [col(0) - 20, -250], col(6), 120);

  w.link('Queue Schedule', 'Prepare Run').link('Manual Trigger (webhook)', 'Prepare Run')
   .link('Prepare Run', 'Find Due').link('Find Due', 'Expand Due').link('Expand Due', 'Dispatch Send')
   .link('Dispatch Send', 'Summarize Dispatch').link('Summarize Dispatch', 'Assert Dispatch');

  return { file: 'revival-queue.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
