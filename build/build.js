// Genera workflows/*.json y credentials/credentials.json a partir de lib/*.js
// Uso: npm run build
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lib = name => fs.readFileSync(path.join(ROOT, 'lib', `${name}.js`), 'utf8');

// Embebe lib/<name>.js dentro de un nodo Code: n8n no permite require() de archivos locales.
function embed(libs, glue) {
  const blocks = libs.map(({ file, exports }) =>
    `const { ${exports.join(', ')} } = (() => {\n  const module = { exports: {} };\n${lib(file)}\n  return module.exports;\n})();`);
  return `${blocks.join('\n')}\n\n${glue}`.trim();
}

const SMTP = { smtp: { id: 'smtpMailpit01', name: 'Mailpit (local SMTP)' } };
const ANTHROPIC = { httpHeaderAuth: { id: 'anthropicKey01', name: 'Anthropic API (PLACEHOLDER)' } };
const GHL = { httpHeaderAuth: { id: 'ghlKey01', name: 'GoHighLevel (PLACEHOLDER)' } };

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function Workflow(id, name) {
  const nodes = [];
  const connections = {};
  const api = {
    add(name, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uid(), name, type, typeVersion, position, ...extra });
      return api;
    },
    link(from, to, outputIndex = 0) {
      connections[from] ??= { main: [] };
      const main = connections[from].main;
      while (main.length <= outputIndex) main.push([]);
      main[outputIndex].push({ node: to, type: 'main', index: 0 });
      return api;
    },
    build(settings) {
      return { id, name, nodes, connections, settings, active: false, pinData: {}, meta: { templateCredsSetupCompleted: false } };
    },
  };
  return api;
}

const code = (jsCode) => ({ mode: 'runOnceForEachItem', jsCode });
const ifBool = (expr) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uid(), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const ifEquals = (expr, value) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uid(), leftValue: expr, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  },
  options: {},
});

// ───────────────────────── Workflow 1: Lead Intake ─────────────────────────
const CONFIG = {
  aiMode: process.env.AI_MODE || 'mock',                // 'mock' = sin API key | 'live' = Claude API
  crmMode: process.env.CRM_MODE || 'mock',               // 'mock' = no envía | 'live' = GoHighLevel
  model: 'claude-sonnet-5-5',
  confidenceThreshold: 0.7,
  hotScore: 75,
  warmScore: 50,
  highValueBudget: 10000,
  targetCountries: ['US', 'CA', 'GB', 'ES', 'MX', 'CO'],
  ownerEmail: 'owner@example.com',
  fromEmail: 'n8n@localhost',
  approvalTimeoutHours: 24,
  ghlLocationId: 'TU_GHL_LOCATION_ID',
};

const w = Workflow('leadintake000001', 'Lead Intake & Qualification (Auditable)');

const approvalLines = `[
  'LEAD ' + lead_id + '  —  ' + lead.name + ' <' + lead.email + '>',
  'Company: ' + (lead.company || 'n/a') + ' | Size: ' + (lead.company_size ?? 'n/a') + ' | Budget: ' + (lead.budget_usd != null ? '$' + lead.budget_usd : 'n/a') + ' | Country: ' + (lead.country || 'n/a'),
  '',
  'DECISION: tier=' + decision.tier.toUpperCase() + ' score=' + decision.final_score + ' (rules ' + rules.rule_score + ' / AI ' + (ai.ok ? ai.assessment.fit_score : 'FAILED') + ')',
  'WHY A HUMAN IS NEEDED: ' + decision.reasons.join(', '),
  ai.ok ? 'AI CONFIDENCE: ' + ai.assessment.confidence + ' (claimed ' + ai.assessment.claimed_confidence + ') | model: ' + ai.assessment.model : 'AI ERROR: ' + decision.ai_error,
  ai.ok ? 'AI SUMMARY: ' + ai.assessment.summary : '',
  ai.ok && ai.assessment.risk_flags.length ? 'RISK FLAGS: ' + ai.assessment.risk_flags.join(', ') : '',
  '',
  'RULE EVIDENCE:',
  ...rules.evidence.map(e => '  +' + e.points + ' ' + e.rule + ' — ' + e.detail),
  '',
  'VERIFIED QUOTES FROM THE LEAD:',
  ...(ai.ok ? ai.assessment.verified_evidence.map(e => '  "' + e.quote + '" → ' + e.supports) : []),
  '',
  'LEAD MESSAGE:',
  lead.message,
].filter(l => l !== undefined)`;

w.add('Lead Webhook', 'n8n-nodes-base.webhook', 2, [0, 300],
  { httpMethod: 'POST', path: 'lead-intake', responseMode: 'responseNode', options: {} }, { webhookId: uid() })
 .add('Config', 'n8n-nodes-base.set', 3.4, [240, 300],
  { mode: 'raw', jsonOutput: JSON.stringify({ config: CONFIG }, null, 2), includeOtherFields: true, options: {} },
  { notes: 'Único lugar para ajustar umbrales y modos (mock/live). Cambia aiMode/crmMode a "live" cuando conectes las APIs.' })
 .add('Normalize & Validate', 'n8n-nodes-base.code', 2, [480, 300], code(embed(
  [{ file: 'normalize', exports: ['normalizeLead'] }],
  `const item = $input.item.json;
const r = normalizeLead(item.body, new Date().toISOString());
return { json: {
  lead_id: r.lead_id, received_at: r.received_at, lead: r.lead,
  validation: { ok: r.ok, errors: r.errors, warnings: r.warnings },
  raw_body: item.body ?? null, config: item.config,
} };`)))
 .add('Valid?', 'n8n-nodes-base.if', 2.2, [720, 300], ifBool('={{ $json.validation.ok }}'))
 .add('Accepted 202', 'n8n-nodes-base.respondToWebhook', 1.4, [960, 200],
  { respondWith: 'json', responseBody: '={{ JSON.stringify({ status: "accepted", lead_id: $json.lead_id, warnings: $json.validation.warnings }) }}', options: { responseCode: 202 } })
 .add('Rejected 422', 'n8n-nodes-base.respondToWebhook', 1.4, [960, 460],
  { respondWith: 'json', responseBody: '={{ JSON.stringify({ status: "rejected", lead_id: $json.lead_id, errors: $json.validation.errors }) }}', options: { responseCode: 422 } })
 .add('Rule Scoring', 'n8n-nodes-base.code', 2, [1200, 200], code(embed(
  [{ file: 'rules', exports: ['scoreByRules'] }],
  `const s = $input.item.json;
return { json: { ...s, rules: scoreByRules(s.lead, s.config) } };`)))
 .add('AI Mode?', 'n8n-nodes-base.if', 2.2, [1440, 200], ifEquals('={{ $json.config.aiMode }}', 'live'))
 .add('Build Claude Request', 'n8n-nodes-base.code', 2, [1680, 100], code(embed(
  [{ file: 'ai', exports: ['buildClaudeRequest'] }],
  `const s = $input.item.json;
return { json: { ...s, claude_request: buildClaudeRequest(s.lead, s.rules, s.config.model) } };`)))
 .add('Claude Qualification', 'n8n-nodes-base.httpRequest', 4.2, [1920, 100], {
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.claude_request) }}',
  options: { timeout: 60000 },
 }, { credentials: ANTHROPIC, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      notes: 'CONECTA AQUÍ: credencial "Anthropic API" (Header Auth: x-api-key). Fallos NO se absorben: Parse Claude Response los convierte en ai_failed → revisión humana.' })
 .add('Parse Claude Response', 'n8n-nodes-base.code', 2, [2160, 100], code(embed(
  [{ file: 'ai', exports: ['parseClaudeResponse'] }],
  `const state = $('Build Claude Request').item.json;
return { json: { ...state, ai: parseClaudeResponse($input.item.json, state.lead) } };`)))
 .add('Mock AI', 'n8n-nodes-base.code', 2, [1680, 320], code(embed(
  [{ file: 'ai', exports: ['mockAssessment'] }],
  `const s = $input.item.json;
return { json: { ...s, ai: { ok: true, assessment: mockAssessment(s.lead, s.rules) } } };`)),
  { notes: 'Sustituto local de Claude (aiMode=mock). Misma forma de salida; se marca model="mock" en la auditoría.' })
 .add('Decision Gate', 'n8n-nodes-base.code', 2, [2400, 200], code(embed(
  [{ file: 'decision', exports: ['decide'] }],
  `const s = $input.item.json;
const decision = decide(s.rules, s.ai, s.lead, s.config);
const { lead, lead_id, rules, ai } = s;
const lines = ${approvalLines};
const approval_text = lines.join("\\n");
// n8n decodifica entidades HTML al armar el email de aprobación, así que &lt; no protege (verificado en 2.43.4).
// Sustituimos por homoglifos que nunca se interpretan como marcado.
const esc = v => String(v).replace(/&/g, "\\uFF06").replace(/</g, "\\u2039").replace(/>/g, "\\u203A");
const approval_message = lines.map(esc).join("\\n");
return { json: { ...s, decision, approval_text, approval_message } };`)),
  { notes: 'DETERMINÍSTICO. La IA nunca decide: solo aporta fit_score/confianza/riesgos. Este nodo aplica umbrales explícitos.' })
 .add('Needs Human?', 'n8n-nodes-base.if', 2.2, [2640, 200], ifBool('={{ $json.decision.needs_human }}'))
 .add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [2880, 100], {
  resource: 'email',
  operation: 'sendAndWait',
  fromEmail: '={{ $json.config.fromEmail }}',
  toEmail: '={{ $json.config.ownerEmail }}',
  subject: "={{ 'Review needed: ' + $json.lead.name + ' (' + $json.decision.tier + ', ' + $json.decision.final_score + ')' }}",
  message: '={{ $json.approval_message }}',
  responseType: 'approval',
  approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve lead', disapproveLabel: 'Reject lead' } },
  options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
 }, { credentials: SMTP, notes: 'Local: llega a Mailpit (http://localhost:8025). En producción cambia la credencial SMTP.' })
 .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [3120, 100], code(embed(
  [{ file: 'decision', exports: ['applyHumanDecision'] }],
  `const state = $('Decision Gate').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, raw_response: $input.item.json, decided_at: new Date().toISOString() }, status: h.status } };`)),
  { notes: 'Falla cerrado: timeout o respuesta ambigua = no_human_response = NO se envía al CRM.' })
 .add('Approved?', 'n8n-nodes-base.if', 2.2, [3360, 100], ifEquals('={{ $json.status }}', 'approved_by_human'))
 .add('CRM Mode?', 'n8n-nodes-base.if', 2.2, [3600, 300], ifEquals('={{ $json.config.crmMode }}', 'live'))
 .add('GHL Upsert Contact', 'n8n-nodes-base.httpRequest', 4.2, [3840, 200], {
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
 }, { credentials: GHL, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      notes: 'CONECTA AQUÍ: credencial GoHighLevel (Header Auth: Authorization = Bearer <Private Integration token>) y ghlLocationId en Config. Contrato del endpoint SIN verificar contra la API real.' })
 .add('Capture CRM Result', 'n8n-nodes-base.code', 2, [4080, 200], code(
  `const s = $('CRM Mode?').item.json;
const r = $input.item.json;
const ok = !r.error && !!(r.contact && r.contact.id);
return { json: { ...s,
  crm: ok ? { ok: true, mode: 'live', contact_id: r.contact.id }
          : { ok: false, mode: 'live', error: r.error ? JSON.stringify(r.error) : 'unexpected response: ' + JSON.stringify(r).slice(0, 500) },
  status: ok ? (s.status || 'auto_processed') : 'crm_failed' } };`))
 .add('Mock CRM', 'n8n-nodes-base.code', 2, [3840, 420], code(
  `const s = $input.item.json;
return { json: { ...s, crm: { ok: true, mode: 'mock', contact_id: 'mock_' + s.lead_id } } };`))
 .add('Hot Lead?', 'n8n-nodes-base.if', 2.2, [4320, 300], ifBool("={{ $json.decision.tier === 'hot' && $json.crm.ok === true }}"))
 .add('Notify Owner', 'n8n-nodes-base.emailSend', 2.1, [4560, 200], {
  resource: 'email',
  operation: 'send',
  fromEmail: '={{ $json.config.fromEmail }}',
  toEmail: '={{ $json.config.ownerEmail }}',
  subject: "={{ 'HOT lead: ' + $json.lead.name + ' (' + $json.decision.final_score + ')' }}",
  emailFormat: 'text',
  text: "={{ 'Status: ' + ($json.status || 'auto_processed') + '\\nCRM contact: ' + $json.crm.contact_id + '\\n\\n' + $json.approval_text }}",
  options: { appendAttribution: false },
 }, { credentials: SMTP, onError: 'continueRegularOutput' })
 .add('Capture Notification', 'n8n-nodes-base.code', 2, [4800, 200], code(
  `const s = $('Hot Lead?').item.json;
const r = $input.item.json;
return { json: { ...s, notify: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`))
 .add('Build Audit Record', 'n8n-nodes-base.code', 2, [5040, 300], code(
  `const s = $input.item.json;
const status = s.status || (s.validation && !s.validation.ok ? 'rejected_invalid' : 'auto_processed');
return { json: { schema: 'lead-audit/v1', ...s, status, execution_id: $execution.id, finished_at: new Date().toISOString() } };`),
  { notes: 'Toda ruta termina aquí: aprobada, rechazada, inválida o fallida. Un archivo JSON inmutable por lead en ./audit/' })
 .add('Convert Audit to File', 'n8n-nodes-base.convertToFile', 1.1, [5280, 300],
  { operation: 'toJson', mode: 'each', binaryPropertyName: 'data', options: { fileName: '={{ $json.lead_id }}.json', format: true } })
 .add('Write Audit File', 'n8n-nodes-base.readWriteFile', 1.1, [5520, 300],
  { operation: 'write', fileName: "=/files/audit/{{ $('Build Audit Record').item.json.lead_id }}.json", dataPropertyName: 'data', options: {} })
 .add('Assert Success', 'n8n-nodes-base.code', 2, [5760, 300], code(
  `const s = $('Build Audit Record').item.json;
if (s.status === 'crm_failed') throw new Error('CRM sync failed for ' + s.lead_id + ': ' + (s.crm && s.crm.error) + ' (audit file written)');
if (s.notify && s.notify.ok === false) throw new Error('Hot-lead notification failed for ' + s.lead_id + ': ' + s.notify.error + ' (audit file written)');
return { json: { lead_id: s.lead_id, status: s.status, tier: s.decision && s.decision.tier } };`),
  { notes: 'Falla ruidosamente DESPUÉS de escribir la evidencia → dispara el Error Handler.' });

for (const [content, pos, wd, ht] of [
  ['## 1 · Ingesta (determinística)\nValida y normaliza. Responde 202/422 de inmediato.', [-20, 120], 1000, 140],
  ['## 2 · Juicio (IA)\nClaude puntúa fit + confianza + citas verbatim. Citas inventadas se descartan y bajan la confianza.', [1160, 20], 1300, 140],
  ['## 3 · Compuerta (determinística)\nUmbrales explícitos deciden si se requiere humano.', [2360, 20], 320, 140],
  ['## 4 · Humano\nAprobación por email. Timeout = no aprobado.', [2840, 0], 560, 120],
  ['## 5 · Acción + 6 · Evidencia\nCRM, notificación y un archivo de auditoría por lead.', [3560, 100], 2400, 130],
]) w.add(`Note ${seq}`, 'n8n-nodes-base.stickyNote', 1, pos, { content, width: wd, height: ht, color: 7 });

w.link('Lead Webhook', 'Config').link('Config', 'Normalize & Validate').link('Normalize & Validate', 'Valid?')
 .link('Valid?', 'Accepted 202', 0).link('Valid?', 'Rejected 422', 1)
 .link('Accepted 202', 'Rule Scoring').link('Rejected 422', 'Build Audit Record')
 .link('Rule Scoring', 'AI Mode?')
 .link('AI Mode?', 'Build Claude Request', 0).link('AI Mode?', 'Mock AI', 1)
 .link('Build Claude Request', 'Claude Qualification').link('Claude Qualification', 'Parse Claude Response')
 .link('Parse Claude Response', 'Decision Gate').link('Mock AI', 'Decision Gate')
 .link('Decision Gate', 'Needs Human?')
 .link('Needs Human?', 'Request Approval', 0).link('Needs Human?', 'CRM Mode?', 1)
 .link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
 .link('Approved?', 'CRM Mode?', 0).link('Approved?', 'Build Audit Record', 1)
 .link('CRM Mode?', 'GHL Upsert Contact', 0).link('CRM Mode?', 'Mock CRM', 1)
 .link('GHL Upsert Contact', 'Capture CRM Result').link('Capture CRM Result', 'Hot Lead?').link('Mock CRM', 'Hot Lead?')
 .link('Hot Lead?', 'Notify Owner', 0).link('Hot Lead?', 'Build Audit Record', 1)
 .link('Notify Owner', 'Capture Notification').link('Capture Notification', 'Build Audit Record')
 .link('Build Audit Record', 'Convert Audit to File').link('Convert Audit to File', 'Write Audit File').link('Write Audit File', 'Assert Success');

// ───────────────────────── Workflow 2: Error Handler ─────────────────────────
const e = Workflow('errhandler000001', 'Global Error Handler');
e.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {})
 .add('Alert Owner', 'n8n-nodes-base.emailSend', 2.1, [260, 0], {
  resource: 'email',
  operation: 'send',
  fromEmail: 'n8n@localhost',
  toEmail: 'owner@example.com',
  subject: "={{ '[n8n ERROR] ' + $json.workflow.name + ' → ' + ($json.execution.lastNodeExecuted || 'unknown node') }}",
  emailFormat: 'text',
  text: "={{ 'Workflow: ' + $json.workflow.name + '\\nNode: ' + ($json.execution.lastNodeExecuted || 'unknown') + '\\nError: ' + $json.execution.error.message + '\\nExecution: ' + $json.execution.url }}",
  options: { appendAttribution: false },
 }, { credentials: SMTP });
e.link('Error Trigger', 'Alert Owner');

const SETTINGS = { executionOrder: 'v1', timezone: 'America/Bogota', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true, saveExecutionProgress: true };

fs.mkdirSync(path.join(ROOT, 'workflows'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'credentials'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'workflows', 'lead-intake.json'), JSON.stringify(w.build({ ...SETTINGS, errorWorkflow: 'errhandler000001' }), null, 2));
fs.writeFileSync(path.join(ROOT, 'workflows', 'error-handler.json'), JSON.stringify(e.build(SETTINGS), null, 2));

// Credenciales: Mailpit es real (local, sin secretos). Las otras son PLACEHOLDERS que reemplazas en la UI de n8n.
const credentials = [
  { id: 'smtpMailpit01', name: 'Mailpit (local SMTP)', type: 'smtp', data: { host: 'mailpit', port: 1025, secure: false, disableStartTls: true, user: '', password: '' } },
  { id: 'anthropicKey01', name: 'Anthropic API (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'x-api-key', value: 'TU_ANTHROPIC_API_KEY' } },
  { id: 'ghlKey01', name: 'GoHighLevel (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer TU_GHL_PRIVATE_INTEGRATION_TOKEN' } },
];
fs.writeFileSync(path.join(ROOT, 'credentials', 'credentials.json'), JSON.stringify(credentials, null, 2));

console.log('built: workflows/lead-intake.json, workflows/error-handler.json, credentials/credentials.json');
