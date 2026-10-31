const { Workflow, embed, CRED, uid, code, codeAll, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { TRIAGE } = require('./triage-config');

const WF = 'triage-intake';
const col = n => n * 240;

const ANTHROPIC_PARAMS = jsonBody => ({
  method: 'POST',
  url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody,
  options: { timeout: 60000 },
});

// Plan del cliente (por dominio del remitente) y carga actual de cada agente: una sola fila.
const CONTEXT_SQL = `SELECT
  (SELECT plan FROM triage_customers WHERE domain = $1 LIMIT 1) AS plan,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_id', a.agent_id, 'name', a.name, 'email', a.email, 'skills', to_jsonb(a.skills), 'max_open', a.max_open, 'active', a.active,
    'open', (SELECT count(*) FROM triage_tickets t WHERE t.assignee_id = a.agent_id AND t.status = 'open')) ORDER BY a.agent_id) FROM triage_agents a), '[]'::jsonb) AS agents`;

// Ticket + evento de auditoría en UNA sentencia. ON CONFLICT DO NOTHING: si el id ya existe es una anomalía y el flujo falla ruidosamente.
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
t AS (
  INSERT INTO triage_tickets (ticket_id, from_email, subject, body, received_at, plan, category, priority, ai_urgency, sentiment, summary, confidence, evidence, reasons,
                              human_triage, p1_candidate, assignee_id, assignee_email, first_response_due, resolution_due, status, classification_model, execution_id)
  SELECT j->>'ticket_id', j->>'from_email', NULLIF(j->>'subject', ''), NULLIF(j->>'body', ''), (j->>'received_at')::timestamptz, NULLIF(j->>'plan', ''), NULLIF(j->>'category', ''), NULLIF(j->>'priority', ''),
         NULLIF(j->>'ai_urgency', ''), NULLIF(j->>'sentiment', ''), NULLIF(j->>'summary', ''), NULLIF(j->>'confidence', '')::numeric, COALESCE(j->'evidence', '{}'::jsonb), COALESCE(j->'reasons', '[]'::jsonb),
         (j->>'human_triage')::boolean, (j->>'p1_candidate')::boolean, NULLIF(j->>'assignee_id', ''), NULLIF(j->>'assignee_email', ''), NULLIF(j->>'first_response_due', '')::timestamptz,
         NULLIF(j->>'resolution_due', '')::timestamptz, j->>'status', NULLIF(j->>'classification_model', ''), j->>'execution_id'
  FROM d
  ON CONFLICT (ticket_id) DO NOTHING
  RETURNING ticket_id
),
e AS (
  INSERT INTO triage_events (ticket_id, event, actor, detail)
  SELECT ticket_id, CASE WHEN (SELECT j->>'status' FROM d) = 'ignored' THEN 'ignored' ELSE 'triaged' END, 'system', COALESCE((SELECT j->'event_detail' FROM d), '{}'::jsonb)
  FROM t RETURNING id
)
SELECT (SELECT count(*) FROM t) AS ticket_rows, (SELECT count(*) FROM e) AS event_rows`;

module.exports = function triageIntake() {
  const w = Workflow('triageintake0001', 'Triage · Ticket Intake (Auditable)');

  // ── Entrada + validación ──
  w.add('Triage Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'triage-ticket', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Ticket entrante normalizado: {ticket_id, from_email, subject, body}. En live lo dispara un Gmail Trigger o el helpdesk con el mismo payload. Protegido por x-triage-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: TRIAGE }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Ticket', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    [{ file: 'triage', exports: ['normalizeTicket'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeTicket(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-triage-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { ticket: n.ticket, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, remitente válido, contenido y tamaños. received_at solo se acepta en modo mock (permite probar el SLA).' })
   .add('Valid Ticket?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1300], 400, '{ status: "rejected", errors: $json.validation.errors }');

  idempotency(w, {
    workflow: WF, position: [col(4), 400], paramCount: 1, params: '$json.ticket.ticket_id', stateFrom: 'Normalize Ticket', check: 'New ticket?',
    keySql: "'triage-ticket:' || $1",
  });
  respond(w, 'Duplicate 200', [col(7), 800], 200, '{ status: "duplicate", ticket_id: $json.ticket.ticket_id }');
  respond(w, 'Accepted 202', [col(7), 400], 202, '{ status: "accepted", ticket_id: $json.ticket.ticket_id }');

  // ── Reglas duras + contexto (determinístico) ──
  w.add('Hard Rules', 'n8n-nodes-base.code', 2, [col(8), 400], code(embed(
    [{ file: 'triage', exports: ['preChecks'] }],
    `const s = $input.item.json;
return { json: { ...s, pre: preChecks(s.ticket) } };`)),
    { notes: 'DETERMINÍSTICO: seguridad / caída de servicio / salud → candidato a P1; legal / disputa de pago → P2. Texto que intenta dar órdenes a la IA ("pon prioridad P4") se marca. La IA no puede deshacer estas reglas.' });
  pg(w, 'Lookup Context', [col(9), 400], CONTEXT_SQL, "[$json.ticket.from_email.split('@')[1]]",
    { alwaysOutputData: true, notes: 'Plan del cliente por dominio del remitente (piso de prioridad) y carga actual de cada agente (tickets abiertos).' });
  w.add('Merge Context', 'n8n-nodes-base.code', 2, [col(10), 400], code(
    `const s = $('Hard Rules').item.json;
const r = $input.item.json;
return { json: { ...s, plan: r.plan || null, agents: r.agents || [] } };`));

  // ── Clasificación (la IA solo LEE) ──
  w.add('Classify AI Mode?', 'n8n-nodes-base.if', 2.2, [col(11), 400], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Classify Request', 'n8n-nodes-base.code', 2, [col(12), 260], code(embed(
    [{ file: 'triage', exports: ['buildClassifyRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClassifyRequest(s.ticket, s.config.model) } };`)),
    { notes: 'El ticket va dentro de <ticket>: es DATO, nunca instrucciones. Claude debe devolver categoría y urgencia con la evidencia textual y su confianza.' })
   .add('Mock Classify', 'n8n-nodes-base.code', 2, [col(12), 520], code(embed(
    [{ file: 'triage', exports: ['mockClassify'] }],
    `const s = $input.item.json;
return { json: { ...s, classification: mockClassify(s.ticket) } };`)),
    { notes: 'Sustituto local de Claude: palabras clave. [[mock:ai_down]] simula la caída del modelo. No mide la calidad de un modelo real.' });
  const clsExit = httpWithBackoff(w, {
    name: 'Claude Classify', position: [col(13), 260], source: 'Build Classify Request', workflow: WF, entity: '$json.ticket.ticket_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (tool record_triage).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Classification', 'n8n-nodes-base.code', 2, [col(16), 260], code(embed(
    [{ file: 'triage', exports: ['parseClassify'] }],
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, classification: parseClassify(http_response) } };`)),
    { notes: 'Valida enums, rango de confianza y que traiga evidencia. Si la respuesta es inválida, falla cerrado (el ticket pasa a una persona).' });

  // ── Fundamentación + decisión (determinístico) ──
  w.add('Ground Classification', 'n8n-nodes-base.code', 2, [col(17), 400], code(embed(
    [{ file: 'triage', exports: ['groundClassification'] }],
    `const s = $input.item.json;
const c = s.classification;
const text = s.ticket.subject + '\\n' + s.ticket.body;
return { json: { ...s, classification: c.ok ? { ok: true, classification: groundClassification(c.classification, text) } : c } };`)),
    { notes: 'DETERMINÍSTICO: la evidencia que cita la IA debe estar en el texto del ticket; si no, su confianza pasa a 0.' })
   .add('Decide Priority', 'n8n-nodes-base.code', 2, [col(18), 400], code(embed(
    [{ file: 'triage', exports: ['decidePriority'] }],
    `const s = $input.item.json;
return { json: { ...s, decision: decidePriority({ pre: s.pre, plan: s.plan, classification: s.classification }, s.config) } };`)),
    { notes: 'DETERMINÍSTICO. Prioridad = la más urgente entre piso de reglas, piso del plan del cliente y propuesta de la IA (solo si está fundamentada y con confianza). P1 exige dos señales independientes (regla dura + IA); con una sola baja a P2 y una persona decide. Inyección, IA caída o confianza baja → revisión humana.' })
   .add('Ignore?', 'n8n-nodes-base.if', 2.2, [col(19), 400], ifEquals('={{ $json.decision.action }}', 'ignore'));

  // ── Asignación + SLA + avisos ──
  w.add('Route & SLA', 'n8n-nodes-base.code', 2, [col(20), 640], code(embed(
    [{ file: 'triage', exports: ['routeTicket', 'slaTargets', 'triageEmails'] }],
    `const s = $input.item.json;
const receivedAt = s.ticket.received_at || new Date().toISOString();
const route = routeTicket({ decision: s.decision, classification: s.classification }, s.agents);
const a = route.assignee ? { agent_id: route.assignee.agent_id, name: route.assignee.name, email: route.assignee.email } : null;
const sla = slaTargets(s.decision.priority, receivedAt, s.config);
const emails = triageEmails({ ticket: s.ticket, decision: s.decision, assignee: a, classification: s.classification, sla }, s.config);
return { json: { ...s, ticket: { ...s.ticket, received_at: receivedAt }, route: { assignee: a, reason: route.reason }, sla, emails } };`)),
    { notes: 'DETERMINÍSTICO: asigna a la persona activa con la habilidad de la categoría y cupo, la de menos tickets abiertos; un ticket en revisión humana no se asigna solo. Plazos de primera respuesta y resolución: P1 en horas corridas, el resto en horario laboral (L–V, con festivos).' })
   .add('Build Emails', 'n8n-nodes-base.code', 2, [col(21), 640], codeAll(
    `const s = $input.first().json;
return s.emails.map(m => ({ json: { from: s.config.fromEmail, to: m.to, subject: m.subject, text: m.text } }));`),
    { notes: 'Un correo por destinatario: la persona asignada y, si hace falta, el líder (P1, candidato a P1, revisión humana o sin asignar).' })
   .add('Send Triage Email', 'n8n-nodes-base.emailSend', 2.1, [col(22), 640], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
    emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local. Si un envío falla, el ticket igual se guarda y el flujo falla ruidosamente al final.' })
   .add('Collect Sends', 'n8n-nodes-base.code', 2, [col(23), 640], codeAll(
    `const s = $('Route & SLA').first().json;
const sent = $('Build Emails').all();
const notices = $input.all().map((r, i) => ({ to: sent[i].json.to, ok: !r.json.error, error: r.json.error ? JSON.stringify(r.json.error) : null }));
return [{ json: { ...s, notices } }];`));

  // ── Estado final + persistencia ──
  w.add('Finalize Ticket', 'n8n-nodes-base.code', 2, [col(24), 400], code(
    `const s = $input.item.json;
const d = s.decision;
const cls = s.classification && s.classification.ok ? s.classification.classification : null;
const errors = [];
const ignored = d.action === 'ignore';
if (!ignored) for (const n of (s.notices || [])) if (!n.ok) errors.push('notification_failed: ' + n.to + ' ' + n.error);
const a = s.route && s.route.assignee;
const row = {
  ticket_id: s.ticket.ticket_id, from_email: s.ticket.from_email, subject: s.ticket.subject, body: s.ticket.body,
  received_at: s.ticket.received_at || new Date().toISOString(), plan: s.plan,
  category: cls ? cls.category : null, priority: d.priority, ai_urgency: cls ? cls.urgency : null, sentiment: cls ? cls.sentiment : null, summary: cls ? cls.summary : null,
  confidence: cls ? cls.confidence : null, evidence: cls ? cls.evidence : {}, reasons: d.reasons, human_triage: d.human_triage, p1_candidate: d.p1_candidate,
  assignee_id: a ? a.agent_id : null, assignee_email: a ? a.email : null,
  first_response_due: s.sla ? s.sla.first_response_due : null, resolution_due: s.sla ? s.sla.resolution_due : null,
  status: ignored ? 'ignored' : 'open', classification_model: cls ? cls.model : null, execution_id: String($execution.id),
  event_detail: { priority: d.priority, reasons: d.reasons, assignee: a ? a.agent_id : null, human_triage: d.human_triage, p1_candidate: d.p1_candidate, notified: (s.notices || []).map(n => n.to), notification_errors: errors },
};
return { json: { ...s, final: { status: row.status, errors }, row } };`),
    { notes: 'Todas las rutas terminan aquí: ignorado (spam) o abierto (asignado / en revisión humana). Un correo que no salió se registra como error.' });
  pg(w, 'Persist Ticket', [col(25), 400], PERSIST_SQL, '[JSON.stringify($json.row)]',
    { notes: 'Ticket, categoría, prioridad, evidencia, motivos, asignación y plazos + evento de auditoría en UNA sentencia atómica.' });
  w.add('Ticket Persisted', 'n8n-nodes-base.code', 2, [col(26), 400], code(
    `const s = $('Finalize Ticket').item.json;
const r = $input.item.json;
if (Number(r.ticket_rows) !== 1 || Number(r.event_rows) !== 1) throw new Error('Persist ticket ' + s.ticket.ticket_id + ' wrote ' + r.ticket_rows + ' ticket rows and ' + r.event_rows + ' event rows (expected 1 and 1): the ticket id already existed');
return { json: { ...s, result: { status: s.final.status, ticket_id: s.ticket.ticket_id, priority: s.row.priority, assignee: s.row.assignee_id, human_triage: s.row.human_triage, errors: s.final.errors } } };`));
  markIdempotency(w, {
    position: [col(27), 300], keyExpr: '$json.idem.key',
    statusExpr: "'done'",
    resultExpr: '({ status: $json.result.status, priority: $json.result.priority })',
  });
  w.add('Assert Ticket', 'n8n-nodes-base.code', 2, [col(27), 520], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Ticket ' + r.ticket_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el ticket guardado y el log escrito → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.ticket.ticket_id', ...o });
  L('Normalize Ticket', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'ticket_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Hard Rules', { step: 'hard_rules', status: "$json.pre.priority || $json.pre.injection ? 'skipped' : 'ok'", error: "($json.pre.signals.map(s => s.label).concat($json.pre.injection ? ['injection'] : [])).join(',')", detail: '({ signals: $json.pre.signals, injection: $json.pre.injection })' });
  L('Ground Classification', { step: 'classified', status: "$json.classification.ok ? 'ok' : 'failed'", error: "$json.classification.ok ? '' : $json.classification.error", detail: '({ category: $json.classification.ok ? $json.classification.classification.category : null, urgency: $json.classification.ok ? $json.classification.classification.urgency : null, confidence: $json.classification.ok ? $json.classification.classification.confidence : null, ungrounded: $json.classification.ok ? $json.classification.classification.ungrounded : null, model: $json.classification.ok ? $json.classification.classification.model : null })' });
  L('Decide Priority', { step: 'prioritized', status: "$json.decision.human_triage ? 'skipped' : 'ok'", error: "$json.decision.human_triage ? $json.decision.reasons.join(',') : ''", detail: '({ decision: $json.decision, plan: $json.plan })' });
  L('Route & SLA', { step: 'routed', status: "$json.route.assignee ? 'ok' : 'skipped'", error: "$json.route.assignee ? '' : $json.route.reason", detail: '({ assignee: $json.route.assignee, sla: $json.sla })' });
  L('Collect Sends', { step: 'notified', status: "$json.notices.every(n => n.ok) ? 'ok' : 'failed'", error: "$json.notices.filter(n => !n.ok).map(n => n.to).join(',')", detail: '({ notices: $json.notices })' });
  L('Ticket Persisted', { step: 'completed', status: "$json.result.errors.length > 0 ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## Triage · Ticket Intake\nHard rules (code) → AI reads the ticket (category, urgency, summary, with evidence and confidence) → code checks the evidence is really in the text → code decides the priority (rule and plan floors; P1 needs two signals) → code assigns by skill and load → code computes the SLA due dates → notify. A person confirms anything doubtful.', [col(0) - 20, -150], col(14), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 1500], 480, 90);

  // ── Conexiones ──
  w.link('Triage Webhook', 'Config').link('Config', 'Normalize Ticket').link('Normalize Ticket', 'Valid Ticket?')
   .link('Valid Ticket?', 'Claim Idempotency', 0).link('Valid Ticket?', 'Respond 400', 1)
   .link('New ticket?', 'Accepted 202', 0).link('New ticket?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Hard Rules').link('Hard Rules', 'Lookup Context').link('Lookup Context', 'Merge Context').link('Merge Context', 'Classify AI Mode?')
   .link('Classify AI Mode?', 'Build Classify Request', 0).link('Classify AI Mode?', 'Mock Classify', 1)
   .link('Build Classify Request', 'Claude Classify').link(clsExit, 'Parse Classification', 1)
   .link('Parse Classification', 'Ground Classification').link('Mock Classify', 'Ground Classification')
   .link('Ground Classification', 'Decide Priority').link('Decide Priority', 'Ignore?')
   .link('Ignore?', 'Finalize Ticket', 0).link('Ignore?', 'Route & SLA', 1)
   .link('Route & SLA', 'Build Emails').link('Build Emails', 'Send Triage Email').link('Send Triage Email', 'Collect Sends').link('Collect Sends', 'Finalize Ticket')
   .link('Finalize Ticket', 'Persist Ticket').link('Persist Ticket', 'Ticket Persisted')
   .link('Ticket Persisted', 'Mark Idempotency').link('Ticket Persisted', 'Assert Ticket');

  return { file: 'triage-intake.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
