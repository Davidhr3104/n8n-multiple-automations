const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff } = require('../foundation');

const WF = 'lead-intake';
// A partir de la columna 8 se desplaza 1 para dejar sitio al nodo de enriquecimiento.
const col = n => (n >= 8 ? n + 1 : n) * 240;

const CONFIG = {
  aiMode: process.env.AI_MODE || 'mock',     // 'mock' = sin API key | 'live' = Claude API
  crmMode: process.env.CRM_MODE || 'mock',   // 'mock' = no envía | 'live' = GoHighLevel
  model: 'claude-sonnet-5-5',
  confidenceThreshold: 0.7,
  hotScore: 75,
  warmScore: 50,
  highValueBudget: 10000,
  // Perfil de cliente ideal: edítalo por cliente. Alimenta las reglas Y el prompt de Claude.
  icp: {
    industries: ['saas', 'software', 'marketing', 'agency', 'legal', 'ecommerce', 'real estate', 'health'],
    excludedIndustries: ['gambling', 'adult'],
    minCompanySize: 10,
    minBudgetUsd: 1000,
    countries: ['US', 'CA', 'GB', 'ES', 'MX', 'CO'],
  },
  // Round-robin entre estos vendedores (contador atómico en Postgres).
  salesReps: [
    { name: 'Rep Uno', email: 'rep1@example.com' },
    { name: 'Rep Dos', email: 'rep2@example.com' },
  ],
  ownerEmail: 'owner@example.com',
  fromEmail: 'n8n@localhost',
  approvalTimeoutHours: 24,
  ghlLocationId: 'TU_GHL_LOCATION_ID',
};

const approvalLines = `[
  'LEAD ' + lead_id + '  —  ' + lead.name + ' <' + lead.email + '>',
  'Company: ' + (lead.company || 'n/a') + ' | Industry: ' + (lead.industry || 'n/a') + ' | Size: ' + (lead.company_size ?? 'n/a') + ' | Budget: ' + (lead.budget_usd != null ? '$' + lead.budget_usd : 'n/a') + ' | Country: ' + (lead.country || 'n/a') + ' | Source: ' + (lead.source || 'n/a'),
  lead.enrichment && lead.enrichment.enriched_fields.length ? 'ENRICHED (derived, not provided by the lead): ' + lead.enrichment.enriched_fields.join(', ') : '',
  '',
  'DECISION: tier=' + decision.tier.toUpperCase() + ' score=' + decision.final_score + ' (rules ' + rules.rule_score + ' / AI ' + (ai.ok ? ai.assessment.fit_score : 'FAILED') + ')',
  'WHY A HUMAN IS NEEDED: ' + decision.reasons.join(', '),
  ai.ok ? 'AI CONFIDENCE: ' + ai.assessment.confidence + ' (claimed ' + ai.assessment.claimed_confidence + ') | model: ' + ai.assessment.model : 'AI ERROR: ' + decision.ai_error,
  ai.ok ? 'AI SUMMARY: ' + ai.assessment.summary : '',
  ai.ok && ai.assessment.risk_flags.length ? 'RISK FLAGS: ' + ai.assessment.risk_flags.join(', ') : '',
  '',
  'RULE EVIDENCE:',
  ...rules.evidence.map(e => '  ' + (e.points >= 0 ? '+' : '') + e.points + ' ' + e.rule + ' — ' + e.detail),
  '',
  'VERIFIED QUOTES FROM THE LEAD:',
  ...(ai.ok ? ai.assessment.verified_evidence.map(e => '  "' + e.quote + '" → ' + e.supports) : []),
  '',
  'LEAD MESSAGE:',
  lead.message,
].filter(l => l !== undefined)`;

// n8n decodifica entidades HTML al armar los emails de aprobación, así que &lt; no protege (verificado en 2.43.4).
// Sustituimos por homoglifos que nunca se interpretan como marcado.
const ESC = `const esc = v => String(v).replace(/&/g, "\\uFF06").replace(/</g, "\\u2039").replace(/>/g, "\\u203A");`;

module.exports = function leadIntake() {
  const w = Workflow('leadintake000001', 'Lead Intake & Qualification (Auditable)');

  // ── Ingesta ──
  w.add('Lead Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'lead-intake', responseMode: 'responseNode', options: {} }, { webhookId: uid() })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: CONFIG }, null, 2), includeOtherFields: true, options: {} },
    { notes: 'Único lugar para ajustar ICP, vendedores, umbrales y modos (mock/live).' })
   .add('Normalize & Validate', 'n8n-nodes-base.code', 2, [col(2), 300], code(embed(
    [{ file: 'adapt', exports: ['adaptPayload'] }, { file: 'normalize', exports: ['normalizeLead'] }],
    `const item = $input.item.json;
// adaptPayload reduce formatos de canal (Meta Lead Ads, email) al payload plano; si ya es plano, lo deja igual.
const r = normalizeLead(adaptPayload(item.body), new Date().toISOString());
return { json: {
  lead_id: r.lead_id, received_at: r.received_at, lead: r.lead,
  validation: { ok: r.ok, errors: r.errors, warnings: r.warnings },
  raw_body: item.body ?? null, config: item.config,
} };`)))
   .add('Valid?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected 422', 'n8n-nodes-base.respondToWebhook', 1.4, [col(4), 560],
    { respondWith: 'json', responseBody: '={{ JSON.stringify({ status: "rejected", lead_id: $json.lead_id, errors: $json.validation.errors }) }}', options: { responseCode: 422 } });

  // ── Idempotencia: reclamo atómico (PRIMARY KEY). Mismo email + mismo mensaje = mismo lead. ──
  w.add('Claim Idempotency', 'n8n-nodes-base.postgres', 2.6, [col(4), 200], {
    operation: 'executeQuery',
    query: `WITH k AS (SELECT 'lead-intake:' || $1 || ':' || md5($2) AS key),
ins AS (
  INSERT INTO idempotency_keys (key, workflow, execution_id, status)
  SELECT key, 'lead-intake', $3, 'processing' FROM k
  ON CONFLICT (key) DO UPDATE
    SET execution_id = EXCLUDED.execution_id, status = 'processing', claimed_at = now(), finished_at = NULL,
        attempts = idempotency_keys.attempts + 1
    WHERE idempotency_keys.status = 'failed'
       OR (idempotency_keys.status = 'processing' AND idempotency_keys.claimed_at < now() - interval '1 hour')
  RETURNING key
)
SELECT (SELECT key FROM k) AS key, EXISTS (SELECT 1 FROM ins) AS is_new`,
    options: { queryReplacement: '={{ [$json.lead.email, $json.lead.message, $execution.id] }}' },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
       notes: 'Reclama la clave en una sola sentencia atómica. Se puede reprocesar si el intento anterior quedó "failed" o "processing" hace más de 1 h.' })
   .add('Idempotency Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Normalize & Validate').item.json;
const r = $input.item.json;
const isNew = r.is_new === true;
return { json: { ...s, idem: { key: r.key, is_new: isNew }, ...(isNew ? {} : { status: 'duplicate_skipped' }) } };`))
   .add('New lead?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.idem.is_new }}'))
   .add('Accepted 202', 'n8n-nodes-base.respondToWebhook', 1.4, [col(7), 100],
    { respondWith: 'json', responseBody: '={{ JSON.stringify({ status: "accepted", lead_id: $json.lead_id, warnings: $json.validation.warnings }) }}', options: { responseCode: 202 } })
   .add('Duplicate 200', 'n8n-nodes-base.respondToWebhook', 1.4, [col(7), 380],
    { respondWith: 'json', responseBody: '={{ JSON.stringify({ status: "duplicate", lead_id: $json.lead_id, idempotency_key: $json.idem.key }) }}', options: { responseCode: 200 } });

  // ── Enriquecimiento (determinístico) + Juicio ──
  w.add('Enrich Lead', 'n8n-nodes-base.code', 2, [8 * 240, 100], code(embed(
    [{ file: 'enrich', exports: ['enrichLead'] }],
    `const s = $input.item.json;
return { json: { ...s, lead: enrichLead(s.lead) } };`)),
    { notes: 'Rellena empresa/país SOLO si faltan y lo declara en enrichment.enriched_fields. Punto de enchufe para Apollo/Clearbit.' })
   .add('Rule Scoring', 'n8n-nodes-base.code', 2, [col(8), 100], code(embed(
    [{ file: 'rules', exports: ['scoreByRules'] }],
    `const s = $input.item.json;
return { json: { ...s, rules: scoreByRules(s.lead, s.config) } };`)))
   .add('AI Mode?', 'n8n-nodes-base.if', 2.2, [col(9), 100], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Claude Request', 'n8n-nodes-base.code', 2, [col(10), 0], code(embed(
    [{ file: 'ai', exports: ['buildClaudeRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildClaudeRequest(s.lead, s.rules, s.config.model, s.config.icp) } };`)))
   .add('Mock AI', 'n8n-nodes-base.code', 2, [col(10), 220], code(embed(
    [{ file: 'ai', exports: ['mockAssessment'] }],
    `const s = $input.item.json;
return { json: { ...s, ai: { ok: true, assessment: mockAssessment(s.lead, s.rules) } } };`)),
    { notes: 'Sustituto local de Claude (aiMode=mock). Misma forma de salida; se marca model="mock" en la auditoría.' });

  const claudeExit = httpWithBackoff(w, {
    name: 'Claude Qualification', position: [col(11), 0], source: 'Build Claude Request', workflow: WF,
    credentials: CRED.anthropic,
    notes: 'CONECTA AQUÍ: credencial "Anthropic API" (Header Auth: x-api-key).',
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
  w.add('Parse Claude Response', 'n8n-nodes-base.code', 2, [col(14), 0], code(embed(
    [{ file: 'ai', exports: ['parseClaudeResponse'] }],
    `const { http_response, ...state } = $input.item.json;
return { json: { ...state, ai: parseClaudeResponse(http_response, state.lead) } };`)),
    { notes: 'Un fallo de la API (tras los reintentos) NO se absorbe: se convierte en ai_failed → revisión humana.' });

  // ── Compuerta determinística ──
  w.add('Decision Gate', 'n8n-nodes-base.code', 2, [col(15), 100], code(embed(
    [{ file: 'decision', exports: ['decide'] }],
    `const s = $input.item.json;
const decision = decide(s.rules, s.ai, s.lead, s.config);
const { lead, lead_id, rules, ai } = s;
const lines = ${approvalLines};
const approval_text = lines.join("\\n");
${ESC}
const approval_message = lines.map(esc).join("\\n");
return { json: { ...s, decision, approval_text, approval_message } };`)),
    { notes: 'DETERMINÍSTICO. La IA nunca decide: solo aporta fit_score/confianza/riesgos. Este nodo aplica umbrales explícitos.' })
   .add('Needs Human?', 'n8n-nodes-base.if', 2.2, [col(16), 100], ifBool('={{ $json.decision.needs_human }}'));

  // ── Humano: aprobación del lead ──
  w.add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [col(17), 0], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Review needed: ' + $json.lead.name + ' (' + $json.decision.tier + ', ' + $json.decision.final_score + ')' }}",
    message: '={{ $json.approval_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve lead', disapproveLabel: 'Reject lead' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Canal de aprobación: email (Mailpit en local). Para Slack, cambiar este nodo por Slack → Send and Wait for Response; el resto del flujo no cambia.' })
   .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [col(18), 0], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Decision Gate').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, raw_response: $input.item.json, decided_at: new Date().toISOString() }, status: h.status } };`)),
    { notes: 'Falla cerrado: timeout o respuesta ambigua = no_human_response = NO se envía al CRM.' })
   .add('Approved?', 'n8n-nodes-base.if', 2.2, [col(19), 0], ifEquals('={{ $json.status }}', 'approved_by_human'));

  // ── Acción: CRM ──
  w.add('CRM Mode?', 'n8n-nodes-base.if', 2.2, [col(20), 200], ifEquals('={{ $json.config.crmMode }}', 'live'))
   .add('Mock CRM', 'n8n-nodes-base.code', 2, [col(21), 320], code(
    `const s = $input.item.json;
return { json: { ...s, crm: { ok: true, mode: 'mock', contact_id: 'mock_' + s.lead_id } } };`));

  const crmExit = httpWithBackoff(w, {
    name: 'GHL Upsert Contact', position: [col(21), 100], source: 'CRM Mode?', workflow: WF,
    credentials: CRED.ghl,
    notes: 'CONECTA AQUÍ: credencial GoHighLevel (Header Auth: Authorization = Bearer <Private Integration token>) y ghlLocationId en Config. Contrato del endpoint SIN verificar contra la API real. El upsert es idempotente por email/teléfono.',
    params: {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/contacts/upsert',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }, { name: 'Accept', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ locationId: $json.config.ghlLocationId, name: $json.lead.name, email: $json.lead.email, phone: $json.lead.phone, companyName: $json.lead.company, source: $json.lead.source || 'n8n-lead-intake', tags: ['tier-' + $json.decision.tier, 'ai-qualified'] }) }}",
      options: { timeout: 30000 },
    },
  });
  w.add('Capture CRM Result', 'n8n-nodes-base.code', 2, [col(24), 100], code(
    `const { http_response: r, ...s } = $input.item.json;
const ok = !r.error && !!(r.contact && r.contact.id);
return { json: { ...s,
  crm: ok ? { ok: true, mode: 'live', contact_id: r.contact.id }
          : { ok: false, mode: 'live', error: r.error ? JSON.stringify(r.error) : 'unexpected response: ' + JSON.stringify(r).slice(0, 500) },
  status: ok ? (s.status || 'auto_processed') : 'crm_failed' } };`))
   .add('Hot Lead?', 'n8n-nodes-base.if', 2.2, [col(25), 200], ifBool("={{ $json.decision.tier === 'hot' && $json.crm.ok === true }}"));

  // ── Leads calientes: asignación round-robin + aprobación del vendedor + primer mensaje ──
  w.add('Assign Rep', 'n8n-nodes-base.postgres', 2.6, [col(26), 100], {
    operation: 'executeQuery',
    query: "SELECT ((nextval('rep_rr_seq') - 1) % GREATEST($1::int, 1))::int AS idx",
    options: { queryReplacement: '={{ [($json.config.salesReps || []).length] }}' },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
       notes: 'Round-robin atómico: nextval() de una secuencia, sin carreras entre leads simultáneos.' })
   .add('Rep Result', 'n8n-nodes-base.code', 2, [col(27), 100], code(`const s = $('Hot Lead?').item.json;
const idx = Number($input.item.json.idx);
const reps = s.config.salesReps || [];
const rep = reps.length ? reps[idx % reps.length] : null;
const draftRaw = s.ai.ok ? s.ai.assessment.draft_message : null;
const draft = draftRaw && rep ? draftRaw.replace(/\\{REP_NAME\\}/g, rep.name) : null;
const reason = !rep ? 'no_reps_configured' : !draft ? (s.ai.ok ? 'no_draft_from_ai' : 'ai_failed') : null;
${ESC}
const rep_message = rep && draft ? [
  'Lead ' + s.lead.name + ' <' + s.lead.email + '> (' + s.decision.tier.toUpperCase() + ', score ' + s.decision.final_score + ') was assigned to you.',
  '',
  'DRAFT FIRST MESSAGE (will be sent to the lead only if you approve):',
  draft,
  '',
  'LEAD MESSAGE:',
  s.lead.message,
].map(esc).join("\\n") : '';
return { json: { ...s, rep, outreach: { draft, status: reason ? 'skipped' : 'pending', reason }, rep_message } };`))
   .add('Notify Owner', 'n8n-nodes-base.emailSend', 2.1, [col(28), 100], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'HOT lead: ' + $json.lead.name + ' (' + $json.decision.final_score + ')' }}",
    emailFormat: 'text',
    text: "={{ 'Status: ' + ($json.status || 'auto_processed') + '\\nCRM contact: ' + $json.crm.contact_id + '\\nAssigned rep: ' + ($json.rep ? $json.rep.name + ' <' + $json.rep.email + '>' : 'none') + '\\nOutreach: ' + $json.outreach.status + ($json.outreach.reason ? ' (' + $json.outreach.reason + ')' : '') + '\\n\\n' + $json.approval_text }}",
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput' })
   .add('Capture Notification', 'n8n-nodes-base.code', 2, [col(29), 100], code(
    `const s = $('Rep Result').item.json;
const r = $input.item.json;
return { json: { ...s, notify: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`))
   .add('Rep assigned?', 'n8n-nodes-base.if', 2.2, [col(30), 100], ifEquals('={{ $json.outreach.status }}', 'pending'))
   .add('Rep Approval', 'n8n-nodes-base.emailSend', 2.1, [col(31), 0], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.rep.email }}',
    subject: "={{ 'Approve first message to ' + $json.lead.name + ' (' + $json.decision.tier + ')' }}",
    message: '={{ $json.rep_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Send message', disapproveLabel: 'Do not send' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Nada sale al lead sin que el vendedor apruebe el mensaje. Timeout = no se envía.' })
   .add('Apply Rep Decision', 'n8n-nodes-base.code', 2, [col(32), 0], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Rep assigned?').item.json;
const h = applyHumanDecision($input.item.json);
const map = { approved_by_human: 'rep_approved', rejected_by_human: 'rep_rejected', no_human_response: 'rep_no_response' };
return { json: { ...state, outreach: { ...state.outreach, status: map[h.status], decided_at: new Date().toISOString() } } };`)))
   .add('Message Approved?', 'n8n-nodes-base.if', 2.2, [col(33), 0], ifEquals('={{ $json.outreach.status }}', 'rep_approved'))
   .add('Send First Message', 'n8n-nodes-base.emailSend', 2.1, [col(34), 0], {
    resource: 'email',
    operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.lead.email }}',
    subject: 'Re: your inquiry',
    emailFormat: 'text',
    text: '={{ $json.outreach.draft }}',
    options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'ACCIÓN EXTERNA: solo se llega aquí tras aprobación del vendedor. En producción cambia por tu SMTP o por el SMS/email de GHL.' })
   .add('Capture Send', 'n8n-nodes-base.code', 2, [col(35), 0], code(
    `const s = $('Message Approved?').item.json;
const r = $input.item.json;
return { json: { ...s, outreach: { ...s.outreach, status: r.error ? 'send_failed' : 'sent', error: r.error ? JSON.stringify(r.error) : undefined } } };`));

  // ── Evidencia ──
  w.add('Build Audit Record', 'n8n-nodes-base.code', 2, [col(36), 200], code(
    `const s = $input.item.json;
const status = s.status || (s.validation && !s.validation.ok ? 'rejected_invalid' : 'auto_processed');
return { json: { schema: 'lead-audit/v2', ...s, status, execution_id: $execution.id, finished_at: new Date().toISOString() } };`),
    { notes: 'Toda ruta termina aquí: aprobada, rechazada, inválida, duplicada o fallida. Un archivo JSON inmutable por lead en ./audit/' })
   .add('Convert Audit to File', 'n8n-nodes-base.convertToFile', 1.1, [col(37), 200],
    { operation: 'toJson', mode: 'each', binaryPropertyName: 'data', options: { fileName: '={{ $json.lead_id }}.json', format: true } })
   .add('Write Audit File', 'n8n-nodes-base.readWriteFile', 1.1, [col(38), 200],
    { operation: 'write', fileName: "=/files/audit/{{ $('Build Audit Record').item.json.lead_id }}.json", dataPropertyName: 'data', options: {} })
   .add('Assert Success', 'n8n-nodes-base.code', 2, [col(39), 200], code(
    `const s = $('Build Audit Record').item.json;
if (s.status === 'crm_failed') throw new Error('CRM sync failed for ' + s.lead_id + ': ' + (s.crm && s.crm.error) + ' (audit file written)');
if (s.notify && s.notify.ok === false) throw new Error('Hot-lead notification failed for ' + s.lead_id + ': ' + s.notify.error + ' (audit file written)');
if (s.outreach && s.outreach.status === 'send_failed') throw new Error('First message failed to send for ' + s.lead_id + ': ' + s.outreach.error + ' (audit file written)');
return { json: { lead_id: s.lead_id, status: s.status, tier: s.decision && s.decision.tier, outreach: s.outreach && s.outreach.status } };`),
    { notes: 'Falla ruidosamente DESPUÉS de escribir la evidencia → dispara el Error Handler.' })
   .add('Mark Idempotency', 'n8n-nodes-base.postgres', 2.6, [col(37), 20], {
    operation: 'executeQuery',
    query: 'UPDATE idempotency_keys SET status = $2, finished_at = now(), result = $3::jsonb WHERE key = $1 AND execution_id = $4',
    options: { queryReplacement: "={{ [($json.idem && $json.idem.key) ?? '', ($json.status === 'crm_failed' || ($json.outreach && $json.outreach.status === 'send_failed')) ? 'failed' : 'done', JSON.stringify({ status: $json.status, lead_id: $json.lead_id }), $execution.id] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
       notes: 'Cierra la clave: done, o failed si el CRM o el envío fallaron (así un reintento sí puede reprocesar). Solo la ejecución dueña de la clave la cierra.' })
   .add('Record Outcome', 'n8n-nodes-base.postgres', 2.6, [col(38), 20], {
    operation: 'executeQuery',
    query: `INSERT INTO lead_outcomes (lead_id, received_at, email, name, company, source, industry, tier, score, status, needs_human, rep_email, outreach_status, execution_id)
VALUES ($1, $2::timestamptz, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, '')::int, $10, $11::boolean, NULLIF($12, ''), NULLIF($13, ''), $14)
ON CONFLICT (lead_id) DO UPDATE SET tier = EXCLUDED.tier, score = EXCLUDED.score, status = EXCLUDED.status, needs_human = EXCLUDED.needs_human,
  rep_email = EXCLUDED.rep_email, outreach_status = EXCLUDED.outreach_status, execution_id = EXCLUDED.execution_id, updated_at = now()`,
    options: { queryReplacement: "={{ [$json.lead_id, $json.received_at, ($json.lead || {}).email ?? '', ($json.lead || {}).name ?? '', ($json.lead || {}).company ?? '', ($json.lead || {}).source ?? '', ($json.lead || {}).industry ?? '', $json.decision ? $json.decision.tier : '', $json.decision ? String($json.decision.final_score) : '', $json.status, String(!!($json.decision && $json.decision.needs_human)), $json.rep ? $json.rep.email : '', $json.outreach ? $json.outreach.status : '', $execution.id] }}" },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, notes: 'Un resultado por lead: alimenta el reporte semanal.' });

  // ── Log por paso (ramas laterales) ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, ...o });
  L('Normalize & Validate', { step: 'received', detail: '({ valid: $json.validation.ok, warnings: $json.validation.warnings.length })' });
  L('Rejected 422', { step: 'rejected_invalid', status: "'skipped'", error: "$json.validation.errors.map(e => e.field + ': ' + e.message).join('; ')" });
  L('Duplicate 200', { step: 'duplicate_skipped', status: "'duplicate'", detail: '({ idempotency_key: $json.idem.key })' });
  L('Enrich Lead', { step: 'enriched', detail: '({ fields: $json.lead.enrichment.enriched_fields })' });
  L('Rule Scoring', { step: 'rules_scored', detail: '({ rule_score: $json.rules.rule_score })' });
  L('Mock AI', { step: 'ai_assessed', name: 'Log · ai_assessed (mock)', detail: '({ model: $json.ai.assessment.model, fit: $json.ai.assessment.fit_score, confidence: $json.ai.assessment.confidence })' });
  L('Parse Claude Response', { step: 'ai_assessed', name: 'Log · ai_assessed (live)', status: "$json.ai.ok ? 'ok' : 'failed'", error: '$json.ai.error', detail: '({ attempts: $json.http.attempt, fit: $json.ai.ok ? $json.ai.assessment.fit_score : null, confidence: $json.ai.ok ? $json.ai.assessment.confidence : null })' });
  L('Decision Gate', { step: 'decision', detail: '({ tier: $json.decision.tier, score: $json.decision.final_score, needs_human: $json.decision.needs_human, reasons: $json.decision.reasons })' });
  L('Needs Human?', { step: 'approval_requested', status: "'waiting'", detail: '({ reasons: $json.decision.reasons })' });
  L('Apply Human Decision', { step: 'human_decision', status: "$json.human.status === 'no_human_response' ? 'failed' : 'ok'", error: "$json.human.status === 'no_human_response' ? 'no human response (timeout or ambiguous)' : ''", detail: '({ result: $json.human.status })' });
  L('Mock CRM', { step: 'crm_sync', name: 'Log · crm_sync (mock)', detail: '({ mode: "mock" })' });
  L('Capture CRM Result', { step: 'crm_sync', name: 'Log · crm_sync (live)', status: "$json.crm.ok ? 'ok' : 'failed'", error: '$json.crm.error', detail: '({ mode: "live", attempts: $json.http.attempt })' });
  L('Rep Result', { step: 'rep_assigned', status: "$json.rep ? 'ok' : 'skipped'", error: "$json.outreach.reason ?? ''", detail: '({ rep: $json.rep ? $json.rep.email : null, outreach: $json.outreach.status })' });
  L('Capture Notification', { step: 'owner_notified', status: "$json.notify.ok ? 'ok' : 'failed'", error: '$json.notify.error' });
  L('Rep assigned?', { step: 'rep_approval_requested', status: "'waiting'", detail: '({ rep: $json.rep.email })' });
  L('Apply Rep Decision', { step: 'rep_decision', status: "$json.outreach.status === 'rep_no_response' ? 'failed' : 'ok'", error: "$json.outreach.status === 'rep_no_response' ? 'no rep response (timeout or ambiguous)' : ''", detail: '({ result: $json.outreach.status })' });
  L('Capture Send', { step: 'first_message', status: "$json.outreach.status === 'sent' ? 'ok' : 'failed'", error: "$json.outreach.error ?? ''" });
  L('Build Audit Record', { step: 'completed', status: "($json.status === 'crm_failed' || ($json.outreach && $json.outreach.status === 'send_failed')) ? 'failed' : 'ok'", error: "$json.status === 'crm_failed' ? 'crm_failed' : (($json.outreach && $json.outreach.status === 'send_failed') ? 'send_failed' : '')", detail: '({ status: $json.status, tier: $json.decision ? $json.decision.tier : null, outreach: $json.outreach ? $json.outreach.status : null })' });

  // ── Notas ──
  w.note('## 1 · Intake + idempotency (deterministic)\nAdapts channel formats, validates, normalizes and claims the key. Replies 202 / 422 / 200-duplicate immediately.', [col(0) - 20, -190], col(8) - 120, 150)
   .note('## 2 · Enrichment + Judgment (AI)\nRules against a configurable ICP; Claude scores fit + confidence + verbatim quotes and drafts the first message. Retries with backoff; on failure, ai_failed → human.', [8 * 240 - 20, -420], col(7), 140)
   .note('## 3 · Gate (deterministic)\nExplicit thresholds decide whether a human is required.', [col(15) - 20, -420], 300, 130)
   .note('## 4 · Human\nLead approval by email. Timeout = not approved.', [col(17) - 20, -420], 700, 110)
   .note('## 5 · CRM\nUpsert with backoff.', [col(20) - 20, -420], 1100, 110)
   .note('## 6 · Hot leads: sales rep + first message\nRound-robin → owner notified → the REP approves the draft → only then is it sent to the lead.', [col(26) - 20, -420], 2200, 130)
   .note('## 7 · Evidence\nAudit trail in ./audit/, idempotency close-out and result for the weekly report.', [col(36) - 20, -420], 1000, 110)
   .note('### Per-step log → Postgres (execution_log)\nThe "Log · …" nodes are side branches: they do not change flow state. If Postgres goes down, the flow fails loudly.', [col(0) - 20, 720], 760, 110);

  // ── Conexiones principales ──
  w.link('Lead Webhook', 'Config').link('Config', 'Normalize & Validate').link('Normalize & Validate', 'Valid?')
   .link('Valid?', 'Claim Idempotency', 0).link('Valid?', 'Rejected 422', 1)
   .link('Claim Idempotency', 'Idempotency Result').link('Idempotency Result', 'New lead?')
   .link('New lead?', 'Accepted 202', 0).link('New lead?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Enrich Lead').link('Rejected 422', 'Build Audit Record').link('Duplicate 200', 'Build Audit Record')
   .link('Enrich Lead', 'Rule Scoring').link('Rule Scoring', 'AI Mode?')
   .link('AI Mode?', 'Build Claude Request', 0).link('AI Mode?', 'Mock AI', 1)
   .link('Build Claude Request', 'Claude Qualification')
   .link(claudeExit, 'Parse Claude Response', 1)
   .link('Parse Claude Response', 'Decision Gate').link('Mock AI', 'Decision Gate')
   .link('Decision Gate', 'Needs Human?')
   .link('Needs Human?', 'Request Approval', 0).link('Needs Human?', 'CRM Mode?', 1)
   .link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
   .link('Approved?', 'CRM Mode?', 0).link('Approved?', 'Build Audit Record', 1)
   .link('CRM Mode?', 'GHL Upsert Contact', 0).link('CRM Mode?', 'Mock CRM', 1)
   .link(crmExit, 'Capture CRM Result', 1)
   .link('Capture CRM Result', 'Hot Lead?').link('Mock CRM', 'Hot Lead?')
   .link('Hot Lead?', 'Assign Rep', 0).link('Hot Lead?', 'Build Audit Record', 1)
   .link('Assign Rep', 'Rep Result').link('Rep Result', 'Notify Owner')
   .link('Notify Owner', 'Capture Notification').link('Capture Notification', 'Rep assigned?')
   .link('Rep assigned?', 'Rep Approval', 0).link('Rep assigned?', 'Build Audit Record', 1)
   .link('Rep Approval', 'Apply Rep Decision').link('Apply Rep Decision', 'Message Approved?')
   .link('Message Approved?', 'Send First Message', 0).link('Message Approved?', 'Build Audit Record', 1)
   .link('Send First Message', 'Capture Send').link('Capture Send', 'Build Audit Record')
   .link('Build Audit Record', 'Convert Audit to File').link('Build Audit Record', 'Mark Idempotency').link('Build Audit Record', 'Record Outcome')
   .link('Convert Audit to File', 'Write Audit File').link('Write Audit File', 'Assert Success');

  return { file: 'lead-intake.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
