const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff } = require('../foundation');

const WF = 'weekly-report';
const col = n => n * 240;

const CONFIG = {
  aiMode: process.env.AI_MODE || 'mock',     // 'mock' = narrativa determinística | 'live' = Claude escribe la narrativa
  model: 'claude-sonnet-5-5',
  ownerEmail: 'owner@example.com',
  fromEmail: 'n8n@localhost',
};

// Cifras 100 % SQL (determinístico). Claude solo redacta la narrativa sobre ESTAS cifras.
const METRICS_SQL = `WITH w AS (SELECT now() - interval '7 days' AS since),
o AS (SELECT lo.* FROM lead_outcomes lo, w WHERE lo.received_at >= w.since)
SELECT jsonb_build_object(
  'period', jsonb_build_object('from', (SELECT since FROM w), 'to', now()),
  'totals', jsonb_build_object(
    'leads', count(*),
    'processed', count(*) FILTER (WHERE status NOT IN ('rejected_invalid', 'duplicate_skipped')),
    'rejected_invalid', count(*) FILTER (WHERE status = 'rejected_invalid'),
    'duplicates', count(*) FILTER (WHERE status = 'duplicate_skipped'),
    'hot', count(*) FILTER (WHERE tier = 'hot'),
    'warm', count(*) FILTER (WHERE tier = 'warm'),
    'cold', count(*) FILTER (WHERE tier = 'cold'),
    'human_reviewed', count(*) FILTER (WHERE needs_human),
    'approved_by_human', count(*) FILTER (WHERE status = 'approved_by_human'),
    'rejected_by_human', count(*) FILTER (WHERE status = 'rejected_by_human'),
    'crm_failed', count(*) FILTER (WHERE status = 'crm_failed'),
    'avg_score', round(avg(score), 1)
  ),
  'by_channel', COALESCE((SELECT jsonb_agg(jsonb_build_object('channel', channel, 'leads', n, 'hot', hot) ORDER BY n DESC)
    FROM (SELECT COALESCE(source, 'unknown') AS channel, count(*) AS n, count(*) FILTER (WHERE tier = 'hot') AS hot
          FROM o WHERE status NOT IN ('rejected_invalid', 'duplicate_skipped') GROUP BY 1) c), '[]'::jsonb),
  'by_rep', COALESCE((SELECT jsonb_agg(jsonb_build_object('rep', rep_email, 'assigned', n) ORDER BY n DESC)
    FROM (SELECT rep_email, count(*) AS n FROM o WHERE rep_email IS NOT NULL GROUP BY 1) r), '[]'::jsonb),
  'top_leads', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'company', company, 'score', score, 'tier', tier, 'source', source) ORDER BY score DESC)
    FROM (SELECT name, company, score, tier, source FROM o WHERE score IS NOT NULL AND status IN ('auto_processed', 'approved_by_human') ORDER BY score DESC LIMIT 5) t), '[]'::jsonb),
  'failures', COALESCE((SELECT jsonb_agg(jsonb_build_object('step', step, 'count', n) ORDER BY n DESC)
    FROM (SELECT step, count(*) AS n FROM execution_log, w WHERE status = 'failed' AND created_at >= w.since GROUP BY step ORDER BY n DESC LIMIT 10) f), '[]'::jsonb)
) AS metrics
FROM o`;

module.exports = function weeklyReport() {
  const w = Workflow('weeklyreport0001', 'Weekly Lead Report (Auditable)');

  w.add('Weekly Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1' }] } },
    { notes: 'Lunes 08:00 (zona horaria del workflow). Idempotente por semana ISO: no envía dos reportes la misma semana.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'weekly-report', responseMode: 'onReceived', options: {} }, { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/weekly-report. Cada llamada manual es una ejecución distinta (no la bloquea la idempotencia semanal).' })
   .add('Prepare Run', 'n8n-nodes-base.code', 2, [col(1), 200], code(
    `const trigger = $('Weekly Schedule').isExecuted ? 'schedule' : 'manual';
return { json: { trigger, config: ${JSON.stringify(CONFIG)} } };`),
    { notes: 'Config del reporte (edítala aquí): aiMode, modelo, destinatario.' })
   .add('Claim Idempotency', 'n8n-nodes-base.postgres', 2.6, [col(2), 200], {
    operation: 'executeQuery',
    query: `WITH k AS (SELECT CASE WHEN $1 = 'schedule' THEN 'weekly-report:' || to_char(date_trunc('week', now()), 'IYYY-"W"IW')
                         ELSE 'weekly-report:manual:' || $2 END AS key),
ins AS (
  INSERT INTO idempotency_keys (key, workflow, execution_id, status)
  SELECT key, 'weekly-report', $2, 'processing' FROM k
  ON CONFLICT (key) DO UPDATE
    SET execution_id = EXCLUDED.execution_id, status = 'processing', claimed_at = now(), finished_at = NULL,
        attempts = idempotency_keys.attempts + 1
    WHERE idempotency_keys.status = 'failed'
       OR (idempotency_keys.status = 'processing' AND idempotency_keys.claimed_at < now() - interval '1 hour')
  RETURNING key
)
SELECT (SELECT key FROM k) AS key, EXISTS (SELECT 1 FROM ins) AS is_new`,
    options: { queryReplacement: '={{ [$json.trigger, $execution.id] }}' },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 })
   .add('Idempotency Result', 'n8n-nodes-base.code', 2, [col(3), 200], code(
    `const s = $('Prepare Run').item.json;
const r = $input.item.json;
return { json: { ...s, idem: { key: r.key, is_new: r.is_new === true } } };`))
   .add('New run?', 'n8n-nodes-base.if', 2.2, [col(4), 200], ifBool('={{ $json.idem.is_new }}'))
   .add('Skip (already sent)', 'n8n-nodes-base.noOp', 1, [col(5), 440], {}, { notes: 'El reporte de esta semana ya se envió (o está en curso).' })
   .add('Load Metrics', 'n8n-nodes-base.postgres', 2.6, [col(5), 100], {
    operation: 'executeQuery', query: METRICS_SQL, options: {},
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 })
   .add('Metrics', 'n8n-nodes-base.code', 2, [col(6), 100], code(
    `const s = $('Idempotency Result').item.json;
return { json: { ...s, metrics: $input.item.json.metrics } };`))
   .add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(7), 100], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Report Request', 'n8n-nodes-base.code', 2, [col(8), 0], code(embed(
    [{ file: 'report', exports: ['buildReportRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildReportRequest(s.metrics, s.config.model) } };`)))
   .add('Mock Report', 'n8n-nodes-base.code', 2, [col(8), 240], code(embed(
    [{ file: 'report', exports: ['mockReport'] }],
    `const s = $input.item.json;
return { json: { ...s, narrative: { ok: true, report: mockReport(s.metrics), source: 'mock' } } };`)),
    { notes: 'Narrativa determinística (aiMode=mock): solo usa las cifras de metrics.' });

  const claudeExit = httpWithBackoff(w, {
    name: 'Claude Report', position: [col(9), 0], source: 'Build Report Request', workflow: WF, entity: '$json.idem.key',
    credentials: CRED.anthropic,
    notes: 'CONECTA AQUÍ: la misma credencial "Anthropic API".',
    params: {
      method: 'POST',
      url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.claude_request) }}',
      options: { timeout: 60000 },
    },
  });

  w.add('Parse Report', 'n8n-nodes-base.code', 2, [col(12), 0], code(embed(
    [{ file: 'report', exports: ['parseReportResponse'] }],
    `const { http_response, ...state } = $input.item.json;
const r = parseReportResponse(http_response);
return { json: { ...state, narrative: { ...r, source: 'claude' } } };`)))
   .add('Render Report', 'n8n-nodes-base.code', 2, [col(13), 100], code(embed(
    [{ file: 'report', exports: ['mockReport', 'renderReportHtml'] }],
    `const s = $input.item.json;
// Si Claude falla, el reporte con cifras SÍ sale (las cifras son SQL), pero lo declara: nunca se disfraza de narrativa de IA.
const failed = !s.narrative.ok;
const report = failed ? mockReport(s.metrics) : s.narrative.report;
const report_source = failed ? 'fallback_after_ai_failure' : s.narrative.source;
const notice = failed ? '<p style="background:#fff3cd;padding:8px">AI narrative unavailable (' + String(s.narrative.error).replace(/[<>&]/g, '') + '). Showing the deterministic summary.</p>' : '';
return { json: { ...s, report, report_source, ai_error: failed ? s.narrative.error : null, report_html: notice + renderReportHtml(s.metrics, report) } };`)),
    { notes: 'El HTML escapa TODO dato de lead (los nombres son texto no confiable).' })
   .add('Send Report', 'n8n-nodes-base.emailSend', 2.1, [col(14), 100], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ '[Weekly] ' + $json.report.headline }}",
    emailFormat: 'html',
    html: '={{ $json.report_html }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput' })
   .add('Capture Send', 'n8n-nodes-base.code', 2, [col(15), 100], code(
    `const s = $('Render Report').item.json;
const r = $input.item.json;
return { json: { ...s, sent: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`))
   .add('Mark Idempotency', 'n8n-nodes-base.postgres', 2.6, [col(16), 20], {
    operation: 'executeQuery',
    query: 'UPDATE idempotency_keys SET status = $2, finished_at = now(), result = $3::jsonb WHERE key = $1 AND execution_id = $4',
    options: { queryReplacement: "={{ [$json.idem.key, $json.sent.ok ? 'done' : 'failed', JSON.stringify({ report_source: $json.report_source, leads: $json.metrics.totals.leads }), $execution.id] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 })
   .add('Assert Sent', 'n8n-nodes-base.code', 2, [col(16), 200], code(
    `const s = $input.item.json;
if (!s.sent.ok) throw new Error('Weekly report email failed: ' + s.sent.error + ' (key ' + s.idem.key + ' marked failed, can be retried)');
return { json: { key: s.idem.key, report_source: s.report_source, leads: s.metrics.totals.leads } };`),
    { notes: 'Falla ruidosamente si el email no salió → Error Handler.' });

  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.idem.key', ...o });
  L('Idempotency Result', { step: 'claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'", detail: '({ trigger: $json.trigger })' });
  L('Metrics', { step: 'metrics_loaded', detail: '({ totals: $json.metrics.totals, channels: $json.metrics.by_channel.length })' });
  L('Mock Report', { step: 'narrative', name: 'Log · narrative (mock)', detail: '({ source: "mock" })' });
  L('Parse Report', { step: 'narrative', name: 'Log · narrative (live)', status: "$json.narrative.ok ? 'ok' : 'failed'", error: "$json.narrative.error ?? ''", detail: '({ source: "claude" })' });
  L('Render Report', { step: 'report_built', status: "$json.report_source === 'fallback_after_ai_failure' ? 'failed' : 'ok'", error: "$json.ai_error ?? ''", detail: '({ report_source: $json.report_source })' });
  L('Capture Send', { step: 'report_sent', status: "$json.sent.ok ? 'ok' : 'failed'", error: "$json.sent.error ?? ''", detail: '({ to: $json.config.ownerEmail })' });

  w.note('## Reporte semanal\nCifras: SQL determinístico sobre lead_outcomes + execution_log. Narrativa: Claude (o mock) usando SOLO esas cifras. Si Claude falla, sale igual con resumen determinístico y lo declara.', [col(0) - 20, -190], col(7), 130)
   .note('### Log por paso → Postgres\nNodos "Log · …": ramas laterales, no alteran el flujo.', [col(0) - 20, 640], 500, 90);

  w.link('Weekly Schedule', 'Prepare Run').link('Manual Trigger (webhook)', 'Prepare Run')
   .link('Prepare Run', 'Claim Idempotency').link('Claim Idempotency', 'Idempotency Result').link('Idempotency Result', 'New run?')
   .link('New run?', 'Load Metrics', 0).link('New run?', 'Skip (already sent)', 1)
   .link('Load Metrics', 'Metrics').link('Metrics', 'AI Mode?')
   .link('AI Mode?', 'Build Report Request', 0).link('AI Mode?', 'Mock Report', 1)
   .link('Build Report Request', 'Claude Report')
   .link(claudeExit, 'Parse Report', 1)
   .link('Parse Report', 'Render Report').link('Mock Report', 'Render Report')
   .link('Render Report', 'Send Report').link('Send Report', 'Capture Send')
   .link('Capture Send', 'Mark Idempotency').link('Capture Send', 'Assert Sent');

  return { file: 'weekly-report.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
