const { Workflow, embed, CRED, uid, code, codeAll, ifBool, ifEquals, logBranch, httpWithBackoff, pg, pgKb, respond, idempotency, markIdempotency } = require('../foundation');
const { SUPPORT } = require('./support-config');

const WF = 'support-ticket';
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

module.exports = function supportTicket() {
  const w = Workflow('supportticket001', 'Support · Ticket Reply Agent (Auditable)');

  // ── Entrada + validación ──
  w.add('Ticket Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'support-ticket', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Ticket entrante normalizado: {ticket_id, from_email, from_name, subject, body, thread_id, message_id}. En live lo dispara el Gmail Trigger con el mismo payload. Protegido por x-support-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SUPPORT }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Ticket', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    [{ file: 'support', exports: ['normalizeTicket'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeTicket(item.body);
const errors = [...n.errors];
if (!item.headers || item.headers['x-support-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { ticket: n.ticket, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id, remitente válido, contenido y tamaños.' })
   .add('Valid Ticket?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1100], 400, '{ status: "rejected", errors: $json.validation.errors }');

  idempotency(w, {
    workflow: WF, position: [col(4), 400], paramCount: 1, params: '$json.ticket.ticket_id', stateFrom: 'Normalize Ticket', check: 'New ticket?',
    keySql: "'support-ticket:' || $1",
  });
  respond(w, 'Duplicate 200', [col(7), 800], 200, '{ status: "duplicate", ticket_id: $json.ticket.ticket_id }');
  respond(w, 'Accepted 202', [col(7), 400], 202, '{ status: "accepted", ticket_id: $json.ticket.ticket_id }');

  // ── Reglas duras ANTES de cualquier IA ──
  w.add('Hard Rules', 'n8n-nodes-base.code', 2, [col(8), 400], code(embed(
    [{ file: 'support', exports: ['preChecks'] }],
    `const s = $input.item.json;
return { json: { ...s, pre: preChecks(s.ticket) } };`)),
    { notes: 'DETERMINÍSTICO: temas sensibles (legal, contracargo, fraude, salud, privacidad) → siempre una persona. Intentos de inyección → se marcan. Esto corre antes de la IA y la IA no puede deshacerlo.' });

  // ── Clasificación (la IA juzga) ──
  w.add('Triage AI Mode?', 'n8n-nodes-base.if', 2.2, [col(9), 400], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Triage Request', 'n8n-nodes-base.code', 2, [col(10), 260], code(embed(
    [{ file: 'support', exports: ['buildClassifyRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClassifyRequest(s.ticket, s.config.model) } };`),
    ), { notes: 'El texto del cliente va dentro de <ticket>: es DATO, nunca instrucciones.' })
   .add('Mock Triage', 'n8n-nodes-base.code', 2, [col(10), 520], code(embed(
    [{ file: 'support', exports: ['mockClassify'] }],
    `const s = $input.item.json;
return { json: { ...s, cls: mockClassify(s.ticket) } };`)),
    { notes: 'Sustituto local de Claude: palabras clave. [[mock:ai_down]] simula la caída del modelo.' });
  const triageExit = httpWithBackoff(w, {
    name: 'Claude Triage', position: [col(11), 260], source: 'Build Triage Request', workflow: WF, entity: '$json.ticket.ticket_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API".',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Triage', 'n8n-nodes-base.code', 2, [col(14), 260], code(embed(
    [{ file: 'support', exports: ['parseClassify'] }],
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, cls: parseClassify(http_response) } };`)),
    { notes: 'Valida enums y rango de confianza. Si el JSON es inválido, falla cerrado (escala a una persona).' })
   .add('Needs Draft?', 'n8n-nodes-base.code', 2, [col(15), 400], code(
    `const s = $input.item.json;
const c = s.cls;
const reasons = [];
if (s.pre.sensitive.length) reasons.push('sensitive');
if (!c.ok) reasons.push('classification_failed');
else {
  if (!c.classification.is_support) reasons.push('not_support');
  if (c.classification.needs_account_action) reasons.push('needs_account_action');
  if (c.classification.sentiment === 'angry') reasons.push('angry_customer');
}
return { json: { ...s, skip_draft: reasons.length > 0, skip_reasons: reasons } };`),
    { notes: 'Si no hace falta (o no conviene) redactar —sensible, acción sobre una cuenta, cliente enojado, no es soporte— no se gasta recuperación ni IA.' })
   .add('Draft Needed?', 'n8n-nodes-base.if', 2.2, [col(16), 400], ifBool('={{ !$json.skip_draft }}'));

  // ── Recuperación: embedding de la pregunta + búsqueda por coseno en pgvector ──
  w.add('Embed Mode?', 'n8n-nodes-base.if', 2.2, [col(17), 260], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Query Embedding', 'n8n-nodes-base.code', 2, [col(18), 120], code(embed(
    [{ file: 'kb', exports: ['buildEmbeddingsRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, embeddings_request: buildEmbeddingsRequest([s.ticket.subject + '\\n' + s.ticket.body], s.config) } };`)))
   .add('Mock Query Embedding', 'n8n-nodes-base.code', 2, [col(18), 380], code(embed(
    [{ file: 'kb', exports: ['embedMock', 'toVectorLiteral'] }],
    `const s = $input.item.json;
return { json: { ...s, qvec: { ok: true, mode: 'mock', literal: toVectorLiteral(embedMock(s.ticket.subject + '\\n' + s.ticket.body)) } } };`)));
  const embExit = httpWithBackoff(w, {
    name: 'Embeddings API', position: [col(19), 120], source: 'Build Query Embedding', workflow: WF, entity: '$json.ticket.ticket_id',
    credentials: CRED.embeddings,
    notes: 'CONECTA AQUÍ: proveedor de embeddings (mismo modelo y 256 dimensiones que en KB Ingest). Contrato SIN verificar.',
    params: {
      method: 'POST',
      url: '={{ $json.config.embeddingsUrl }}',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'content-type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.embeddings_request) }}',
      options: { timeout: 60000 },
    },
  });
  w.add('Parse Query Embedding', 'n8n-nodes-base.code', 2, [col(22), 120], code(embed(
    [{ file: 'kb', exports: ['parseEmbeddings', 'toVectorLiteral'] }],
    `const { http_response, ...s } = $input.item.json;
const r = parseEmbeddings(http_response, 1);
return { json: { ...s, qvec: r.ok ? { ok: true, mode: 'live', literal: toVectorLiteral(r.vectors[0]) } : { ok: false, mode: 'live', error: r.error } } };`)))
   .add('Embedding OK?', 'n8n-nodes-base.if', 2.2, [col(23), 260], ifBool('={{ $json.qvec.ok }}'))
   .add('Retrieval Failed', 'n8n-nodes-base.code', 2, [col(24), 560], code(
    `const s = $input.item.json;
return { json: { ...s, retrieval: { ok: false, error: s.qvec.error, sources: [], top_similarity: 0 }, draft: null } };`));
  pgKb(w, 'Search KB', [col(24), 260],
    `SELECT c.id, c.doc_id, d.title, c.content, round((1 - (c.embedding <=> $1::vector))::numeric, 4) AS similarity
FROM kb_chunks c JOIN kb_docs d USING (doc_id)
ORDER BY c.embedding <=> $1::vector LIMIT 4`,
    '[$json.qvec.literal]', { alwaysOutputData: true, notes: 'pgvector: distancia coseno (<=>). Devuelve los 4 fragmentos más cercanos con su similitud (1 = idéntico).' });
  w.add('Retrieved', 'n8n-nodes-base.code', 2, [col(25), 260], codeAll(
    `const s = $('Embedding OK?').first().json;
const rows = $input.all().map(i => i.json).filter(r => r.id !== undefined && r.id !== null);
const sources = rows.map(r => ({ id: Number(r.id), doc_id: r.doc_id, title: r.title, content: r.content, similarity: Number(r.similarity) }));
return [{ json: { ...s, retrieval: { ok: true, sources, top_similarity: sources.length ? sources[0].similarity : 0 } } }];`),
    { notes: 'Se guardan los fragmentos usados y su similitud: la respuesta siempre es auditable.' });

  // ── Redacción con fuentes (la IA redacta, solo con esos fragmentos) ──
  w.add('Draft AI Mode?', 'n8n-nodes-base.if', 2.2, [col(26), 260], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Draft Request', 'n8n-nodes-base.code', 2, [col(27), 120], code(embed(
    [{ file: 'support', exports: ['buildDraftRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildDraftRequest(s.ticket, s.retrieval.sources, s.config.model) } };`)))
   .add('Mock Draft', 'n8n-nodes-base.code', 2, [col(27), 380], code(embed(
    [{ file: 'kb', exports: ['tokenize'] }, { file: 'support', exports: ['mockDraft'] }],
    `const s = $input.item.json;
return { json: { ...s, draft: mockDraft(s.ticket, s.retrieval.sources, { tokenize }) } };`)),
    { notes: 'Sustituto local: un "modelo" extractivo que solo copia frases de los fragmentos recuperados y se abstiene si nada es relevante.' });
  const draftExit = httpWithBackoff(w, {
    name: 'Claude Draft', position: [col(28), 120], source: 'Build Draft Request', workflow: WF, entity: '$json.ticket.ticket_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Claude solo ve los fragmentos recuperados.',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Draft', 'n8n-nodes-base.code', 2, [col(31), 120], code(embed(
    [{ file: 'support', exports: ['parseDraft'] }],
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, draft: parseDraft(http_response) } };`)));

  // ── Validación + compuerta (determinístico) ──
  w.add('Validate & Gate', 'n8n-nodes-base.code', 2, [col(32), 400], code(embed(
    [{ file: 'support', exports: ['validateDraft', 'gate'] }],
    `const s = $input.item.json;
const sources = s.retrieval ? s.retrieval.sources : [];
const validation = s.draft && s.draft.ok ? validateDraft(s.draft.draft, sources) : { ok: false, issues: ['no_draft'] };
const g = gate({ pre: s.pre, cls: s.cls, retrieval: s.retrieval, draft: s.draft, validation }, s.config);
return { json: { ...s, validation, gate: g } };`)),
    { notes: 'DETERMINÍSTICO. Sale sola SOLO si: es soporte, no es sensible, no pide una acción, el cliente no está enojado, la similitud y la confianza superan el umbral y CADA cifra, link o email de la respuesta está en el texto citado. Si no: una persona aprueba el borrador o se escala sin borrador.' })
   .add('Auto?', 'n8n-nodes-base.if', 2.2, [col(33), 400], ifEquals('={{ $json.gate.action }}', 'auto'))
   .add('Review?', 'n8n-nodes-base.if', 2.2, [col(34), 640], ifEquals('={{ $json.gate.action }}', 'review'))
   .add('Escalate?', 'n8n-nodes-base.if', 2.2, [col(35), 900], ifEquals('={{ $json.gate.action }}', 'escalate'));

  // ── Humano: aprobar el borrador ──
  w.add('Build Review Message', 'n8n-nodes-base.code', 2, [col(35), 640], code(embed(
    [{ file: 'support', exports: ['reviewMessage'] }],
    `const s = $input.item.json;
return { json: { ...s, review_message: reviewMessage({ ticket: s.ticket, gate: s.gate, draft: s.draft, sources: s.retrieval.sources, cls: s.cls }) } };`)))
   .add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [col(36), 640], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.supportOwnerEmail }}',
    subject: "={{ 'Approve reply to ' + $json.ticket.from_email + ' (' + $json.ticket.ticket_id + ')' }}",
    message: '={{ $json.review_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Send reply', disapproveLabel: 'Do not send' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Canal de aprobación: email (Mailpit en local). Para Slack, cambiar este nodo por Slack → Send and Wait; el resto no cambia. Timeout = no se envía.' })
   .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [col(37), 640], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Review Message').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: solo un "sí" explícito cuenta. Timeout o respuesta ambigua = no se envía.' })
   .add('Approved?', 'n8n-nodes-base.if', 2.2, [col(38), 640], ifEquals('={{ $json.human.status }}', 'approved_by_human'));

  // ── Escalamiento sin borrador ──
  w.add('Build Escalation', 'n8n-nodes-base.code', 2, [col(36), 900], code(embed(
    [{ file: 'support', exports: ['escalationMessage'] }],
    `const s = $input.item.json;
return { json: { ...s, escalation_message: escalationMessage({ ticket: s.ticket, gate: s.gate, cls: s.cls }) } };`)))
   .add('Notify Human', 'n8n-nodes-base.emailSend', 2.1, [col(37), 900], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.supportOwnerEmail }}',
    subject: "={{ 'Needs a person: ' + $json.ticket.ticket_id + ' (' + $json.gate.reasons[0] + ')' }}",
    emailFormat: 'text',
    text: '={{ $json.escalation_message }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso a una persona con el motivo. Al cliente NO se le responde.' })
   .add('Capture Notice', 'n8n-nodes-base.code', 2, [col(38), 900], code(
    `const s = $('Build Escalation').item.json;
const r = $input.item.json;
return { json: { ...s, notice: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Enviar la respuesta en el mismo hilo ──
  w.add('Compose Reply', 'n8n-nodes-base.code', 2, [col(39), 400], code(
    `const s = $input.item.json;
const text = s.draft.draft.answer + '\\n\\n— ' + s.config.storeName + ' Support';
return { json: { ...s, reply_text: text } };`),
    { notes: 'Llegan aquí solo las respuestas automáticas y las aprobadas por una persona.' })
   .add('Gmail Mode?', 'n8n-nodes-base.if', 2.2, [col(40), 400], ifEquals('={{ $json.config.gmailMode }}', 'live'))
   .add('Send Reply (mock email)', 'n8n-nodes-base.emailSend', 2.1, [col(41), 560], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.ticket.from_email }}',
    subject: "={{ /^re:/i.test($json.ticket.subject) ? $json.ticket.subject : 'Re: ' + $json.ticket.subject }}",
    emailFormat: 'text',
    text: '={{ $json.reply_text }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA simulada: el email llega a Mailpit con "Re: asunto". En live se responde en el hilo real con la Gmail API (threadId + In-Reply-To).' })
   .add('Capture Mock Send', 'n8n-nodes-base.code', 2, [col(42), 560], code(
    `const s = $('Compose Reply').item.json;
const r = $input.item.json;
return { json: { ...s, send: r.error ? { ok: false, mode: 'mock', error: JSON.stringify(r.error) } : { ok: true, mode: 'mock' } } };`))
   .add('Build Raw Reply', 'n8n-nodes-base.code', 2, [col(41), 300], code(embed(
    [{ file: 'support', exports: ['buildRawReply'] }],
    `const s = $input.item.json;
const raw = buildRawReply({ from: s.config.fromEmail, to: s.ticket.from_email, subject: s.ticket.subject, text: s.reply_text, messageId: s.ticket.message_id });
return { json: { ...s, gmail_request: { raw, threadId: s.ticket.thread_id || undefined } } };`)));
  const gmailExit = httpWithBackoff(w, {
    name: 'Gmail Send', position: [col(42), 300], source: 'Build Raw Reply', workflow: WF, entity: '$json.ticket.ticket_id',
    credentials: CRED.gmail,
    notes: 'CONECTA AQUÍ: credencial Gmail (token OAuth en una cabecera Authorization). users.messages.send con threadId + In-Reply-To mantiene el hilo. Contrato SIN verificar contra Gmail real.',
    params: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'content-type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.gmail_request) }}',
      options: { timeout: 30000 },
    },
  });
  w.add('Capture Live Send', 'n8n-nodes-base.code', 2, [col(45), 300], code(
    `const { http_response: r, ...s } = $input.item.json;
return { json: { ...s, send: r.error || !r.id ? { ok: false, mode: 'live', error: JSON.stringify(r.error || r).slice(0, 300) } : { ok: true, mode: 'live', gmail_message_id: r.id } } };`));

  // ── Estado final + persistencia ──
  w.add('Finalize Status', 'n8n-nodes-base.code', 2, [col(46), 640], code(
    `const s = $input.item.json;
const action = s.gate.action;
const errors = [];
let status;
if (action === 'ignore') status = 'ignored';
else if (action === 'escalate') { status = 'escalated'; if (s.notice && !s.notice.ok) errors.push('escalation_email_failed: ' + s.notice.error); }
else if (action === 'review' && s.human && s.human.status !== 'approved_by_human') status = s.human.status === 'rejected_by_human' ? 'rejected' : 'no_response';
else if (s.send && s.send.ok) status = action === 'auto' ? 'auto_replied' : 'approved_sent';
else { status = 'failed'; errors.push('reply_send_failed: ' + (s.send ? s.send.error : 'no send result')); }
const cls = s.cls && s.cls.ok ? s.cls.classification : null;
const sources = s.retrieval ? s.retrieval.sources.map(x => ({ id: x.id, doc_id: x.doc_id, title: x.title, similarity: x.similarity })) : [];
return { json: { ...s, final: { status, errors, intent: cls ? cls.intent : null, sentiment: cls ? cls.sentiment : null,
  top_similarity: s.retrieval ? s.retrieval.top_similarity : null, confidence: s.draft && s.draft.ok ? s.draft.draft.confidence : null,
  sources, citations: s.draft && s.draft.ok ? s.draft.draft.citations : [], reply_text: ['auto_replied', 'approved_sent'].includes(status) ? s.reply_text : (s.draft && s.draft.ok ? s.draft.draft.answer : null) } } };`),
    { notes: 'Todas las rutas terminan aquí: ignorado, escalado, rechazado, sin respuesta, enviado automáticamente o enviado tras aprobación.' });
  pg(w, 'Persist Ticket', [col(47), 640],
    `INSERT INTO support_tickets (ticket_id, from_email, from_name, subject, body, thread_id, message_id, status, intent, sentiment, action, reasons, top_similarity, confidence, sources, citations, reply_text, execution_id, replied_at)
VALUES ($1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11, $12::jsonb, $13::numeric, $14::numeric, $15::jsonb, $16::jsonb, $17, $18, CASE WHEN $8 IN ('auto_replied', 'approved_sent') THEN now() END)
ON CONFLICT (ticket_id) DO UPDATE SET status = EXCLUDED.status, intent = EXCLUDED.intent, sentiment = EXCLUDED.sentiment, action = EXCLUDED.action, reasons = EXCLUDED.reasons,
  top_similarity = EXCLUDED.top_similarity, confidence = EXCLUDED.confidence, sources = EXCLUDED.sources, citations = EXCLUDED.citations, reply_text = EXCLUDED.reply_text,
  execution_id = EXCLUDED.execution_id, replied_at = EXCLUDED.replied_at, updated_at = now()
RETURNING ticket_id`,
    "[$json.ticket.ticket_id, $json.ticket.from_email, $json.ticket.from_name, $json.ticket.subject, $json.ticket.body, $json.ticket.thread_id, $json.ticket.message_id, $json.final.status, $json.final.intent, $json.final.sentiment, $json.gate.action, JSON.stringify($json.gate.reasons), $json.final.top_similarity === null ? null : String($json.final.top_similarity), $json.final.confidence === null ? null : String($json.final.confidence), JSON.stringify($json.final.sources), JSON.stringify($json.final.citations), $json.final.reply_text, $execution.id]",
    { notes: 'Ticket, decisión, motivos, fragmentos usados (con similitud) y respuesta: todo auditable.' });
  w.add('Ticket Persisted', 'n8n-nodes-base.code', 2, [col(48), 640], code(
    `const s = $('Finalize Status').item.json;
if (!$input.item.json.ticket_id) throw new Error('Persist ticket ' + s.ticket.ticket_id + ' wrote no row');
return { json: { ...s, result: { status: s.final.status, ticket_id: s.ticket.ticket_id, action: s.gate.action, reasons: s.gate.reasons, errors: s.final.errors } } };`));
  markIdempotency(w, {
    position: [col(49), 540], keyExpr: '$json.idem.key',
    statusExpr: "$json.result.status === 'failed' || $json.result.errors.length > 0 ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status, action: $json.result.action })',
  });
  w.add('Assert Ticket', 'n8n-nodes-base.code', 2, [col(49), 740], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Ticket ' + r.ticket_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar estado y log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.ticket.ticket_id', ...o });
  L('Normalize Ticket', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'ticket_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Hard Rules', { step: 'hard_rules', status: "$json.pre.sensitive.length || $json.pre.injection ? 'skipped' : 'ok'", error: "$json.pre.sensitive.map(s => 'sensitive:' + s).concat($json.pre.injection ? ['injection'] : []).join(',')", detail: '({ sensitive: $json.pre.sensitive, injection: $json.pre.injection })' });
  L('Needs Draft?', { step: 'triaged', status: "$json.cls.ok ? 'ok' : 'failed'", error: "$json.cls.ok ? '' : $json.cls.error", detail: '({ classification: $json.cls.ok ? $json.cls.classification : null, skip_draft: $json.skip_draft, skip_reasons: $json.skip_reasons })' });
  L('Retrieved', { step: 'retrieved', detail: '({ top_similarity: $json.retrieval.top_similarity, sources: $json.retrieval.sources.map(s => ({ id: s.id, doc: s.doc_id, similarity: s.similarity })) })' });
  L('Retrieval Failed', { step: 'retrieval_failed', status: "'failed'", error: '$json.retrieval.error' });
  L('Validate & Gate', { step: 'gated', status: "$json.gate.action === 'auto' ? 'ok' : 'skipped'", error: "$json.gate.action === 'auto' ? '' : $json.gate.reasons.join(',')", detail: '({ action: $json.gate.action, reasons: $json.gate.reasons, validation: $json.validation, draft_ok: $json.draft ? $json.draft.ok : null, top_similarity: $json.retrieval ? $json.retrieval.top_similarity : null, cited_docs: $json.draft && $json.draft.ok ? $json.draft.draft.citations.map(id => ($json.retrieval.sources.find(x => x.id === id) || {}).doc_id) : [], draft_answer: $json.draft && $json.draft.ok ? $json.draft.draft.answer : null })' });
  L('Apply Human Decision', { step: 'human_decided', status: "$json.human.status === 'approved_by_human' ? 'ok' : 'skipped'", error: "$json.human.status === 'approved_by_human' ? '' : $json.human.status" });
  L('Capture Notice', { step: 'human_notified', status: "$json.notice.ok ? 'ok' : 'failed'", error: "$json.notice.error ?? ''" });
  L('Capture Mock Send', { step: 'reply_sent', name: 'Log · reply_sent (mock)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ mode: "mock" })' });
  L('Capture Live Send', { step: 'reply_sent', name: 'Log · reply_sent (live)', status: "$json.send.ok ? 'ok' : 'failed'", error: "$json.send.error ?? ''", detail: '({ mode: "live" })' });
  L('Ticket Persisted', { step: 'completed', status: "$json.result.errors.length > 0 ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## Support · Ticket Reply Agent\nHard rules (code) → triage (AI judges) → retrieve from pgvector → draft from the retrieved sources only (AI writes) → code checks that every number, link and email is in the cited text → gate: auto-reply / a person approves / escalate with no draft.', [col(0) - 20, -150], col(14), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 1500], 480, 90);

  // ── Conexiones ──
  w.link('Ticket Webhook', 'Config').link('Config', 'Normalize Ticket').link('Normalize Ticket', 'Valid Ticket?')
   .link('Valid Ticket?', 'Claim Idempotency', 0).link('Valid Ticket?', 'Respond 400', 1)
   .link('New ticket?', 'Accepted 202', 0).link('New ticket?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Hard Rules').link('Hard Rules', 'Triage AI Mode?')
   .link('Triage AI Mode?', 'Build Triage Request', 0).link('Triage AI Mode?', 'Mock Triage', 1)
   .link('Build Triage Request', 'Claude Triage').link(triageExit, 'Parse Triage', 1)
   .link('Parse Triage', 'Needs Draft?').link('Mock Triage', 'Needs Draft?').link('Needs Draft?', 'Draft Needed?')
   .link('Draft Needed?', 'Embed Mode?', 0).link('Draft Needed?', 'Validate & Gate', 1)
   .link('Embed Mode?', 'Build Query Embedding', 0).link('Embed Mode?', 'Mock Query Embedding', 1)
   .link('Build Query Embedding', 'Embeddings API').link(embExit, 'Parse Query Embedding', 1)
   .link('Parse Query Embedding', 'Embedding OK?').link('Mock Query Embedding', 'Embedding OK?')
   .link('Embedding OK?', 'Search KB', 0).link('Embedding OK?', 'Retrieval Failed', 1).link('Retrieval Failed', 'Validate & Gate')
   .link('Search KB', 'Retrieved').link('Retrieved', 'Draft AI Mode?')
   .link('Draft AI Mode?', 'Build Draft Request', 0).link('Draft AI Mode?', 'Mock Draft', 1)
   .link('Build Draft Request', 'Claude Draft').link(draftExit, 'Parse Draft', 1)
   .link('Parse Draft', 'Validate & Gate').link('Mock Draft', 'Validate & Gate')
   .link('Validate & Gate', 'Auto?')
   .link('Auto?', 'Compose Reply', 0).link('Auto?', 'Review?', 1)
   .link('Review?', 'Build Review Message', 0).link('Review?', 'Escalate?', 1)
   .link('Build Review Message', 'Request Approval').link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
   .link('Approved?', 'Compose Reply', 0).link('Approved?', 'Finalize Status', 1)
   .link('Escalate?', 'Build Escalation', 0).link('Escalate?', 'Finalize Status', 1)
   .link('Build Escalation', 'Notify Human').link('Notify Human', 'Capture Notice').link('Capture Notice', 'Finalize Status')
   .link('Compose Reply', 'Gmail Mode?')
   .link('Gmail Mode?', 'Build Raw Reply', 0).link('Gmail Mode?', 'Send Reply (mock email)', 1)
   .link('Build Raw Reply', 'Gmail Send').link(gmailExit, 'Capture Live Send', 1)
   .link('Send Reply (mock email)', 'Capture Mock Send')
   .link('Capture Mock Send', 'Finalize Status').link('Capture Live Send', 'Finalize Status')
   .link('Finalize Status', 'Persist Ticket').link('Persist Ticket', 'Ticket Persisted')
   .link('Ticket Persisted', 'Mark Idempotency').link('Ticket Persisted', 'Assert Ticket');

  return { file: 'support-ticket.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
