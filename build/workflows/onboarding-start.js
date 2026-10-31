const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { ONB } = require('./onboarding-config');

const WF = 'onboarding-start';
const col = n => n * 240;
// onboarding.js usa ./schedule: debe registrarse primero o el nodo falla al cargar en n8n
const O = exports_ => [{ file: 'schedule', exports: [] }, { file: 'onboarding', exports: exports_ }];

const ANTHROPIC_PARAMS = jsonBody => ({
  method: 'POST',
  url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true, specifyBody: 'json', jsonBody, options: { timeout: 60000 },
});

const DUP_SQL = `SELECT (SELECT client_id FROM onb_clients WHERE client_id <> $1 AND (lower(contact_email) = $2 OR lower(company) = $3) ORDER BY created_at LIMIT 1) AS duplicate`;

// Cliente + contrato + evento en UNA sentencia. El token de firma se genera aquí, en Postgres, y caduca.
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
c AS (
  INSERT INTO onb_clients (client_id, company, contact_name, contact_email, package, amount, currency, start_date, notes, status, summary, flags)
  SELECT j->>'client_id', j->>'company', j->>'contact_name', j->>'contact_email', j->>'package', (j->>'amount')::numeric, j->>'currency', (j->>'start_date')::date, NULLIF(j->>'notes', ''),
         j->>'status', COALESCE(j->'summary', '{}'::jsonb), COALESCE(j->'flags', '{}'::jsonb)
  FROM d ON CONFLICT (client_id) DO NOTHING RETURNING client_id
),
k AS (
  INSERT INTO onb_contracts (client_id, text, token, approved_by, expires_at)
  SELECT j->>'client_id', j->>'contract', md5(random()::text || clock_timestamp()::text || (j->>'client_id')), NULLIF(j->>'approved_by', ''), (j->>'now')::timestamptz + ((j->>'expiry_days')::int * interval '1 day')
  FROM d WHERE j->>'status' = 'contract_pending' AND EXISTS (SELECT 1 FROM c) RETURNING token
),
e AS (
  INSERT INTO onb_events (client_id, event, actor, detail)
  SELECT j->>'client_id', CASE WHEN j->>'status' = 'rejected' THEN 'rejected' ELSE 'created' END, COALESCE(NULLIF(j->>'approved_by', ''), 'system'), COALESCE(j->'flags', '{}'::jsonb)
  FROM d WHERE EXISTS (SELECT 1 FROM c) RETURNING id
)
SELECT (SELECT count(*) FROM c) AS clients, (SELECT token FROM k LIMIT 1) AS token`;

// El contrato cuenta como enviado solo si el correo salió: si no, el cliente sigue en contract_pending y un barrido lo reintenta.
const SENT_SQL = `WITH d AS (SELECT $1::jsonb AS j),
u AS (UPDATE onb_clients c SET status = 'awaiting_signature', updated_at = now(), version = c.version + 1 FROM d
      WHERE c.client_id = d.j->>'client_id' AND c.status = 'contract_pending' AND (d.j->>'ok')::boolean RETURNING c.client_id),
k AS (UPDATE onb_contracts k SET sent_at = (d.j->>'now')::timestamptz FROM d WHERE k.client_id = d.j->>'client_id' AND (d.j->>'ok')::boolean AND k.sent_at IS NULL RETURNING k.client_id),
s AS (INSERT INTO onb_steps (client_id, step, status, error, execution_id)
      SELECT j->>'client_id', 'contract_sent', CASE WHEN (j->>'ok')::boolean THEN 'ok' ELSE 'failed' END, NULLIF(j->>'error', ''), j->>'execution_id' FROM d
      ON CONFLICT (client_id, step) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, execution_id = EXCLUDED.execution_id, created_at = now() RETURNING client_id),
e AS (INSERT INTO onb_events (client_id, event, actor, detail)
      SELECT j->>'client_id', CASE WHEN (j->>'ok')::boolean THEN 'contract_sent' ELSE 'contract_send_failed' END, 'system', jsonb_build_object('error', j->>'error') FROM d RETURNING id)
SELECT (SELECT count(*) FROM u) AS advanced, (SELECT count(*) FROM s) AS steps`;

module.exports = function onboardingStart() {
  const w = Workflow('onboardingstart01', 'Onboarding · Start (Auditable)');

  // ── Entrada + validación + idempotencia ──
  w.add('Start Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 520],
    { httpMethod: 'POST', path: 'onboarding-start', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Cliente cerrado: {client_id, company, contact_name, contact_email, package, amount, currency?, start_date?, notes?}. En live lo dispara el CRM al ganar el trato. Protegido por x-onboarding-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 520], { mode: 'raw', jsonOutput: JSON.stringify({ config: ONB }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Client', 'n8n-nodes-base.code', 2, [col(2), 520], code(embed(O(['normalizeStart']),
    `const item = $input.item.json;
const c = item.config;
const n = normalizeStart(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-onboarding-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { client: n.client, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, empresa y contacto, email válido, paquete que existe, monto, fechas. "now" solo en mock con token.' })
   .add('Valid Client?', 'n8n-nodes-base.if', 2.2, [col(3), 520], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1700], 400, '{ status: "rejected", errors: $json.validation.errors }');
  idempotency(w, { workflow: WF, position: [col(4), 420], paramCount: 1, params: '$json.client.client_id', stateFrom: 'Normalize Client', check: 'New client?', keySql: "'onb-start:' || $1" });
  respond(w, 'Duplicate 200', [col(7), 820], 200, '{ status: "duplicate", client_id: $json.client.client_id }');
  respond(w, 'Accepted 202', [col(7), 420], 202, '{ status: "accepted", client_id: $json.client.client_id }');

  // ── Reglas duras + duplicados ──
  w.add('Hard Rules', 'n8n-nodes-base.code', 2, [col(8), 420], code(embed(O(['preChecks']),
    `const s = $input.item.json;
const now = s.client.now || new Date().toISOString();
const client = { ...s.client, start_date: s.client.start_date || now.slice(0, 10) };
return { json: { ...s, client, now, pre: preChecks(client, s.config) } };`)),
    { notes: 'DETERMINÍSTICO: términos especiales en las notas (descuento, reembolso, exclusividad, NDA, penalizaciones, garantías), intento de dar órdenes al sistema y correo gratuito (solo informativo).' });
  pg(w, 'Lookup Duplicates', [col(9), 420], DUP_SQL, '[$json.client.client_id, $json.client.contact_email, $json.client.company.toLowerCase()]',
    { alwaysOutputData: true, notes: 'Otro cliente con el mismo email o la misma empresa: no se envía un segundo contrato sin que una persona lo vea.' });
  w.add('Merge Duplicate', 'n8n-nodes-base.code', 2, [col(10), 420], code(
    `const s = $('Hard Rules').item.json;
return { json: { ...s, duplicate: $input.item.json.duplicate || null } };`))
   .add('Has Notes?', 'n8n-nodes-base.if', 2.2, [col(11), 420], ifBool('={{ $json.client.notes.length > 0 }}'))
   .add('No Notes', 'n8n-nodes-base.code', 2, [col(12), 700], code(
    `const s = $input.item.json;
return { json: { ...s, summary_result: { ok: true, summary: { summary: '', requirements: [], confidence: 1, model: 'none' } } } };`),
    { notes: 'Sin notas no hay nada que leer: no se llama a la IA.' });

  // ── Notas del formulario: la IA solo LEE ──
  w.add('Summary AI Mode?', 'n8n-nodes-base.if', 2.2, [col(12), 300], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Summarize Request', 'n8n-nodes-base.code', 2, [col(13), 160], code(embed(O(['buildSummarizeRequest']),
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildSummarizeRequest(s.client.notes, s.config.model) } };`)),
    { notes: 'Las notas van dentro de <notes>: son DATO, nunca instrucciones. Cada requisito debe traer la frase textual de la que sale.' })
   .add('Mock Summarize', 'n8n-nodes-base.code', 2, [col(13), 440], code(embed(O(['mockSummarize']),
    `const s = $input.item.json;
return { json: { ...s, summary_result: mockSummarize(s.client.notes) } };`)),
    { notes: 'Sustituto local de Claude: frases con "need / want / require / must / please". [[mock:ai_down]] simula la caída del modelo.' });
  const sumExit = httpWithBackoff(w, {
    name: 'Claude Summarize', position: [col(14), 160], source: 'Build Summarize Request', workflow: WF, entity: '$json.client.client_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (tool record_intake_summary).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Summary', 'n8n-nodes-base.code', 2, [col(17), 160], code(embed(O(['parseSummarize']),
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, summary_result: parseSummarize(http_response) } };`)),
    { notes: 'Valida la forma y que cada requisito traiga su evidencia. Si no, falla cerrado.' })
   .add('Ground Requirements', 'n8n-nodes-base.code', 2, [col(18), 420], code(embed(O(['groundRequirements']),
    `const s = $input.item.json;
const r = s.summary_result;
const g = r.ok ? groundRequirements(r.summary, s.client.notes) : { kept: [], dropped: [] };
return { json: { ...s, grounded: { ok: r.ok, error: r.ok ? null : r.error, summary: r.ok ? r.summary.summary : '', kept: g.kept, dropped: g.dropped, model: r.ok ? r.summary.model : null } } };`)),
    { notes: 'DETERMINÍSTICO: solo los requisitos cuya cita está de verdad en las notas se convertirán en tareas. Lo que la IA inventó se descarta y queda registrado.' });

  // ── Contrato por plantilla + compuerta ──
  w.add('Build Contract & Gate', 'n8n-nodes-base.code', 2, [col(19), 420], code(embed(O(['buildContract', 'contractGate']),
    `const s = $input.item.json;
const contract = buildContract(s.client, s.config, s.now);
const gate = contractGate({ client: s.client, pre: s.pre, duplicate: s.duplicate }, s.config);
if (!s.grounded.ok && s.client.notes) { gate.reasons.push('summary_failed'); gate.action = 'review'; }
return { json: { ...s, contract, gate } };`)),
    { notes: 'El contrato lo escribe una PLANTILLA por paquete, nunca la IA. Sale solo únicamente si: paquete estándar, monto bajo el límite, sin términos especiales, sin cliente duplicado, sin intento de inyección y con las notas leídas. Si no, aprueba el responsable.' })
   .add('Needs Review?', 'n8n-nodes-base.if', 2.2, [col(20), 420], ifEquals('={{ $json.gate.action }}', 'review'));

  // ── Humano: aprobar o no enviar ──
  w.add('Build Approval Message', 'n8n-nodes-base.code', 2, [col(21), 220], code(embed(O(['approvalMessage']),
    `const s = $input.item.json;
return { json: { ...s, review_message: approvalMessage({ client: s.client, gate: s.gate, summary: { requirements: s.grounded.kept }, contractText: s.contract }) } };`)))
   .add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [col(22), 220], {
    resource: 'email', operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Approve contract: ' + $json.client.company }}", message: '={{ $json.review_message }}', responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Send the contract', disapproveLabel: 'Do not send' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Canal de aprobación: email (Mailpit en local). Para Slack, cambiar este nodo por Slack → Send and Wait. Sin respuesta en 48 h no se envía nada.' })
   .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [col(23), 220], code(embed([{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Approval Message').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: solo un "sí" explícito cuenta. Timeout o respuesta ambigua = no se envía el contrato.' })
   .add('Approved?', 'n8n-nodes-base.if', 2.2, [col(24), 220], ifEquals('={{ $json.human.status }}', 'approved_by_human'));

  // ── Guardar y enviar ──
  w.add('Build Row', 'n8n-nodes-base.code', 2, [col(25), 420], code(
    `const s = $input.item.json;
const approvedBy = s.human ? (s.human.status === 'approved_by_human' ? 'account_manager' : null) : 'auto';
const rejected = approvedBy === null;
const c = s.client;
const row = {
  client_id: c.client_id, company: c.company, contact_name: c.contact_name, contact_email: c.contact_email, package: c.package, amount: c.amount, currency: c.currency, start_date: c.start_date, notes: c.notes,
  status: rejected ? 'rejected' : 'contract_pending',
  summary: { summary: s.grounded.summary, requirements: s.grounded.kept, dropped: s.grounded.dropped, model: s.grounded.model },
  flags: { gate: s.gate.reasons, freemail: s.pre.freemail, duplicate: s.duplicate, summary_failed: !s.grounded.ok, human: s.human ? s.human.status : null },
  contract: s.contract, approved_by: approvedBy || '', now: s.now, expiry_days: s.config.contractExpiryDays,
};
return { json: { ...s, row } };`),
    { notes: 'Todas las rutas llegan aquí: enviar (automático o aprobado) o no enviar (rechazado o sin respuesta). Un rechazo también queda registrado.' });
  pg(w, 'Persist Client', [col(26), 420], PERSIST_SQL, '[JSON.stringify($json.row)]',
    { notes: 'Cliente, contrato (token de un solo uso generado en Postgres, con caducidad) y evento de auditoría en UNA sentencia atómica.' });
  w.add('Client Persisted', 'n8n-nodes-base.code', 2, [col(27), 420], code(
    `const s = $('Build Row').item.json;
const r = $input.item.json;
if (Number(r.clients) !== 1) throw new Error('Persist client ' + s.row.client_id + ' wrote ' + r.clients + ' rows: the client id already existed');
return { json: { ...s, token: r.token || null } };`))
   .add('Send Contract?', 'n8n-nodes-base.if', 2.2, [col(28), 420], ifEquals('={{ $json.row.status }}', 'contract_pending'))
   .add('Build Contract Email', 'n8n-nodes-base.code', 2, [col(29), 280], code(embed(O(['contractEmail']),
    `const s = $input.item.json;
const link = s.config.baseUrl + '/onboarding-sign?client_id=' + encodeURIComponent(s.client.client_id) + '&token=' + s.token;
return { json: { ...s, mail: contractEmail({ client: s.client, contractText: s.contract, link }, s.config) } };`)),
    { notes: 'El enlace abre una página con el contrato; firmar es un POST con el token de un solo uso.' })
   .add('Send Contract', 'n8n-nodes-base.emailSend', 2.1, [col(30), 280], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.mail.to }}', subject: '={{ $json.mail.subject }}',
    emailFormat: 'text', text: '={{ $json.mail.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local. En live: Dropbox Sign / DocuSign (contrato SIN verificar). Si falla, el cliente sigue en contract_pending y el barrido lo reintenta.' })
   .add('Capture Send', 'n8n-nodes-base.code', 2, [col(31), 280], code(
    `const s = $('Build Contract Email').item.json;
const r = $input.item.json;
return { json: { ...s, send: { ok: !r.error, error: r.error ? JSON.stringify(r.error) : '' } } };`));
  pg(w, 'Record Contract Sent', [col(32), 280], SENT_SQL, '[JSON.stringify({ client_id: $json.client.client_id, ok: $json.send.ok, error: $json.send.error, now: $json.now, execution_id: String($execution.id) })]',
    { notes: 'El contrato cuenta como enviado solo si el correo salió.' });
  w.add('Final · sent', 'n8n-nodes-base.code', 2, [col(33), 280], code(
    `const s = $('Capture Send').item.json;
const errors = s.send.ok ? [] : ['contract_email_failed: ' + s.send.error + '. The client stays contract_pending and the sweep retries the send.'];
return { json: { ...s, result: { status: s.send.ok ? 'awaiting_signature' : 'contract_pending', client_id: s.client.client_id, gate: s.gate.reasons, approved_by: s.row.approved_by, errors } } };`))
   .add('Final · not sent', 'n8n-nodes-base.code', 2, [col(29), 640], code(
    `const s = $('Client Persisted').item.json;
return { json: { ...s, result: { status: 'rejected', client_id: s.client.client_id, gate: s.gate.reasons, approved_by: '', errors: [] } } };`),
    { notes: 'La persona no aprobó (o no respondió): no se envía nada y el cliente queda registrado como rechazado.' });
  markIdempotency(w, { position: [col(34), 380], keyExpr: '$json.idem.key', statusExpr: "'done'", resultExpr: '({ status: $json.result.status })' });
  w.add('Assert Start', 'n8n-nodes-base.code', 2, [col(34), 560], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Onboarding ' + r.client_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log escritos → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.client.client_id', ...o });
  L('Normalize Client', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'client_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Hard Rules', { step: 'hard_rules', status: "$json.pre.custom_terms.length || $json.pre.injection ? 'skipped' : 'ok'", error: "$json.pre.custom_terms.concat($json.pre.injection ? ['injection'] : []).join(',')", detail: '({ pre: $json.pre })' });
  L('Ground Requirements', { step: 'notes_read', status: "$json.grounded.ok ? 'ok' : 'failed'", error: "$json.grounded.ok ? '' : $json.grounded.error", detail: '({ kept: $json.grounded.kept.length, dropped: $json.grounded.dropped, model: $json.grounded.model })' });
  L('Build Contract & Gate', { step: 'gated', status: "$json.gate.action === 'auto' ? 'ok' : 'skipped'", error: "$json.gate.reasons.join(',')", detail: '({ gate: $json.gate, duplicate: $json.duplicate })' });
  L('Apply Human Decision', { step: 'human_decided', status: "$json.human.status === 'approved_by_human' ? 'ok' : 'skipped'", error: "$json.human.status === 'approved_by_human' ? '' : $json.human.status" });
  L('Client Persisted', { step: 'persisted', detail: '({ status: $json.row.status })' });
  L('Capture Send', { step: 'contract_sent', status: "$json.send.ok ? 'ok' : 'failed'", error: '$json.send.error' });
  L('Final · sent', { step: 'completed', status: "$json.result.errors.length ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });
  L('Final · not sent', { step: 'completed', name: 'Log · completed (not sent)', detail: '({ result: $json.result })' });

  w.note('## Onboarding · Start\nCode validates and checks for duplicates, the AI only reads the form notes (every requirement quoted from them), a TEMPLATE writes the contract, and a gate decides: send automatically or ask the account manager. The contract counts as sent only when the email went out.', [col(0) - 20, -150], col(20), 130);

  w.link('Start Webhook', 'Config').link('Config', 'Normalize Client').link('Normalize Client', 'Valid Client?')
   .link('Valid Client?', 'Claim Idempotency', 0).link('Valid Client?', 'Respond 400', 1)
   .link('New client?', 'Accepted 202', 0).link('New client?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Hard Rules').link('Hard Rules', 'Lookup Duplicates').link('Lookup Duplicates', 'Merge Duplicate').link('Merge Duplicate', 'Has Notes?')
   .link('Has Notes?', 'Summary AI Mode?', 0).link('Has Notes?', 'No Notes', 1)
   .link('Summary AI Mode?', 'Build Summarize Request', 0).link('Summary AI Mode?', 'Mock Summarize', 1)
   .link('Build Summarize Request', 'Claude Summarize').link(sumExit, 'Parse Summary', 1)
   .link('Parse Summary', 'Ground Requirements').link('Mock Summarize', 'Ground Requirements').link('No Notes', 'Ground Requirements')
   .link('Ground Requirements', 'Build Contract & Gate').link('Build Contract & Gate', 'Needs Review?')
   .link('Needs Review?', 'Build Approval Message', 0).link('Needs Review?', 'Build Row', 1)
   .link('Build Approval Message', 'Request Approval').link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
   .link('Approved?', 'Build Row', 0).link('Approved?', 'Build Row', 1)
   .link('Build Row', 'Persist Client').link('Persist Client', 'Client Persisted').link('Client Persisted', 'Send Contract?')
   .link('Send Contract?', 'Build Contract Email', 0).link('Send Contract?', 'Final · not sent', 1)
   .link('Build Contract Email', 'Send Contract').link('Send Contract', 'Capture Send').link('Capture Send', 'Record Contract Sent').link('Record Contract Sent', 'Final · sent')
   .link('Final · sent', 'Mark Idempotency').link('Final · sent', 'Assert Start')
   .link('Final · not sent', 'Mark Idempotency').link('Final · not sent', 'Assert Start');

  return { file: 'onboarding-start.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
