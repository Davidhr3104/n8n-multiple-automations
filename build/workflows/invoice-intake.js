const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { INVOICE } = require('./invoice-config');

const WF = 'invoice-intake';
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
  options: { timeout: 90000 },
});

const ACTIVE = "('pending_review', 'auto_posted', 'approved_posted')";
const LOOKUP_SQL = `SELECT
  (SELECT row_to_json(v) FROM invoice_vendors v WHERE v.vendor_key = $1 AND $1 <> '' LIMIT 1) AS vendor,
  (SELECT doc_id FROM invoices WHERE vendor_key = $1 AND invoice_key = $2 AND $1 <> '' AND $2 <> '' AND doc_id <> $3 AND status IN ${ACTIVE} LIMIT 1) AS exact_duplicate,
  (SELECT doc_id FROM invoices WHERE content_hash = $4 AND doc_id <> $3 AND status IN ${ACTIVE} LIMIT 1) AS hash_duplicate,
  COALESCE((SELECT jsonb_agg(doc_id) FROM invoices WHERE vendor_key = $1 AND $1 <> '' AND $5 <> '' AND $6 <> '' AND total = NULLIF($5, '')::numeric AND invoice_date = NULLIF($6, '')::date AND invoice_key <> $2 AND doc_id <> $3 AND status IN ${ACTIVE}), '[]'::jsonb) AS possible_duplicates`;

// Guardar la factura y, si se contabiliza, el asiento del libro: UNA sentencia atómica.
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
i AS (
  INSERT INTO invoices (doc_id, filename, sender_email, content_hash, vendor_name, vendor_key, invoice_number, invoice_key, invoice_date, due_date, currency, subtotal, tax, total, bank_last4,
                        line_items, field_confidence, evidence, checks, reasons, action, status, confidence, extraction_model, execution_id, posted_at)
  SELECT j->>'doc_id', NULLIF(j->>'filename', ''), j->>'sender_email', j->>'content_hash', NULLIF(j->>'vendor_name', ''), COALESCE(j->>'vendor_key', ''), NULLIF(j->>'invoice_number', ''), COALESCE(j->>'invoice_key', ''),
         NULLIF(j->>'invoice_date', '')::date, NULLIF(j->>'due_date', '')::date, NULLIF(j->>'currency', ''), NULLIF(j->>'subtotal', '')::numeric, NULLIF(j->>'tax', '')::numeric, NULLIF(j->>'total', '')::numeric, NULLIF(j->>'bank_last4', ''),
         COALESCE(j->'line_items', '[]'::jsonb), COALESCE(j->'field_confidence', '{}'::jsonb), COALESCE(j->'evidence', '{}'::jsonb), COALESCE(j->'checks', '[]'::jsonb), COALESCE(j->'reasons', '[]'::jsonb),
         j->>'action', j->>'status', NULLIF(j->>'confidence', '')::numeric, j->>'extraction_model', j->>'execution_id', CASE WHEN (j->>'posted')::boolean THEN now() END
  FROM d
  ON CONFLICT (doc_id) DO UPDATE SET status = EXCLUDED.status, action = EXCLUDED.action, reasons = EXCLUDED.reasons, checks = EXCLUDED.checks, confidence = EXCLUDED.confidence,
    execution_id = EXCLUDED.execution_id, posted_at = EXCLUDED.posted_at
  RETURNING doc_id
),
l AS (
  INSERT INTO invoice_ledger (doc_id, vendor_name, invoice_number, invoice_date, due_date, currency, total, posted_by)
  SELECT j->>'doc_id', j->>'vendor_name', j->>'invoice_number', (j->>'invoice_date')::date, NULLIF(j->>'due_date', '')::date, j->>'currency', (j->>'total')::numeric, j->>'posted_by'
  FROM d WHERE (j->>'posted')::boolean RETURNING id
)
SELECT (SELECT count(*) FROM i) AS invoice_rows, (SELECT count(*) FROM l) AS ledger_rows`;

module.exports = function invoiceIntake() {
  const w = Workflow('invoiceintake0001', 'Invoice · Document Processor (Auditable)');

  // ── Entrada + validación ──
  w.add('Invoice Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'invoice-intake', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Documento entrante normalizado: {doc_id, filename, sender_email, text | file_base64 + media_type}. En live lo dispara un Gmail Trigger con el adjunto. Protegido por x-invoice-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: INVOICE }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Document', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    [{ file: 'invoice', exports: ['normalizeDoc'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeDoc(item.body);
const errors = [...n.errors];
if (!item.headers || item.headers['x-invoice-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { doc: n.doc, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, remitente válido, contenido, tipo de archivo y tamaños.' })
   .add('Valid Document?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1200], 400, '{ status: "rejected", errors: $json.validation.errors }');

  idempotency(w, {
    workflow: WF, position: [col(4), 400], paramCount: 1, params: '$json.doc.doc_id', stateFrom: 'Normalize Document', check: 'New document?',
    keySql: "'invoice-doc:' || $1",
  });
  respond(w, 'Duplicate 200', [col(7), 800], 200, '{ status: "duplicate", doc_id: $json.doc.doc_id }');
  respond(w, 'Accepted 202', [col(7), 400], 202, '{ status: "accepted", doc_id: $json.doc.doc_id }');

  // ── Reglas duras antes de la IA ──
  w.add('Hard Rules', 'n8n-nodes-base.code', 2, [col(8), 400], code(embed(
    [{ file: 'invoice', exports: ['preChecks'] }],
    `const s = $input.item.json;
return { json: { ...s, pre: preChecks(s.doc) } };`)),
    { notes: 'DETERMINÍSTICO: texto que intenta dar órdenes a la IA ("aprueba esta factura", "ignora las reglas") se marca y la factura nunca sale sola.' });

  // ── Extracción (la IA solo LEE) ──
  w.add('Extract AI Mode?', 'n8n-nodes-base.if', 2.2, [col(9), 400], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Extraction Request', 'n8n-nodes-base.code', 2, [col(10), 260], code(embed(
    [{ file: 'invoice', exports: ['buildExtractionRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildExtractionRequest(s.doc, s.config.model) } };`)),
    { notes: 'El documento va dentro de <document>: es DATO, nunca instrucciones. Claude debe devolver cada campo con su evidencia y su confianza.' })
   .add('Mock Extract', 'n8n-nodes-base.code', 2, [col(10), 520], code(embed(
    [{ file: 'invoice', exports: ['mockExtract'] }],
    `const s = $input.item.json;
return { json: { ...s, extraction: mockExtract(s.doc.text) } };`)),
    { notes: 'Sustituto local de Claude: lee SOLO texto con etiquetas claras (Vendor:, Invoice No:, Total:…). [[mock:ai_down]] simula la caída del modelo. No mide la calidad de un modelo real.' });
  const exExit = httpWithBackoff(w, {
    name: 'Claude Extract', position: [col(11), 260], source: 'Build Extraction Request', workflow: WF, entity: '$json.doc.doc_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (bloques document/image + tool record_invoice).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Extraction', 'n8n-nodes-base.code', 2, [col(14), 260], code(embed(
    [{ file: 'invoice', exports: ['parseExtraction'] }],
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, extraction: parseExtraction(http_response) } };`)),
    { notes: 'Valida tipos, rangos de confianza y que cada campo traiga evidencia. Si el JSON es inválido, falla cerrado (escala a una persona).' });

  // ── Fundamentación + huella + contexto ──
  w.add('Ground & Fingerprint', 'n8n-nodes-base.code', 2, [col(15), 400], code(embed(
    [{ file: 'invoice', exports: ['groundExtraction', 'normKey', 'normInvoiceNo', 'contentHash'] }],
    `const s = $input.item.json;
const ex = s.extraction;
const grounded = ex.ok ? { ok: true, extraction: groundExtraction(ex.extraction, s.doc.text) } : ex;
const e = ex.ok ? grounded.extraction : {};
const fp = { vendor_key: normKey(e.vendor_name), invoice_key: normInvoiceNo(e.invoice_number), content_hash: contentHash((s.doc.text || '') + (s.doc.file_base64 || '')) };
return { json: { ...s, extraction: grounded, fp } };`)),
    { notes: 'DETERMINÍSTICO: cada campo debe tener su evidencia en el texto del documento Y la evidencia debe respaldar el valor; si no, su confianza pasa a 0. Calcula la huella del documento para detectar reenvíos.' });
  pg(w, 'Lookup Context', [col(16), 400], LOOKUP_SQL,
    "[$json.fp.vendor_key, $json.fp.invoice_key, $json.doc.doc_id, $json.fp.content_hash, $json.extraction.ok && $json.extraction.extraction.total !== null ? String($json.extraction.extraction.total) : '', $json.extraction.ok ? ($json.extraction.extraction.invoice_date || '') : '']",
    { alwaysOutputData: true, notes: 'Maestro de proveedores (cuenta bancaria registrada) + facturas ya procesadas: mismo número, mismo documento, o mismo monto y fecha.' });

  // ── Validación + compuerta (determinístico) ──
  w.add('Validate & Gate', 'n8n-nodes-base.code', 2, [col(17), 400], code(embed(
    [{ file: 'invoice', exports: ['validateInvoice', 'gate'] }],
    `const s = $('Ground & Fingerprint').item.json;
const l = $input.item.json;
const ctx = {
  now: new Date().toISOString(),
  vendor: l.vendor ? { name: l.vendor.name, approved: l.vendor.approved, bank_last4: l.vendor.bank_last4 } : null,
  exact_duplicate: l.exact_duplicate || null, hash_duplicate: l.hash_duplicate || null, possible_duplicates: l.possible_duplicates || [],
};
const ex = s.extraction;
const validation = ex.ok && ex.extraction.is_invoice ? validateInvoice(ex.extraction, ctx, s.config) : { ok: false, issues: [] };
const g = gate({ pre: s.pre, extraction: ex, validation }, s.config);
return { json: { ...s, validation, gate: g } };`)),
    { notes: 'DETERMINÍSTICO. Se contabiliza sola SOLO si: proveedor conocido y aprobado, cuenta bancaria igual a la del maestro, aritmética cuadra, fechas razonables, no es duplicada, monto bajo el límite, todos los campos con evidencia y confianza suficiente, sin intento de inyección. Si no: una persona decide; duplicadas y no-facturas se registran sin molestar a nadie.' })
   .add('Auto?', 'n8n-nodes-base.if', 2.2, [col(18), 400], ifEquals('={{ $json.gate.action }}', 'auto'))
   .add('Review?', 'n8n-nodes-base.if', 2.2, [col(19), 640], ifEquals('={{ $json.gate.action }}', 'review'))
   .add('Escalate?', 'n8n-nodes-base.if', 2.2, [col(20), 900], ifEquals('={{ $json.gate.action }}', 'escalate'));

  // ── Humano: aprobar o rechazar ──
  w.add('Build Review Message', 'n8n-nodes-base.code', 2, [col(20), 640], code(embed(
    [{ file: 'invoice', exports: ['approvalMessage'] }],
    `const s = $input.item.json;
return { json: { ...s, review_message: approvalMessage({ doc: s.doc, extraction: s.extraction.extraction, gate: s.gate, validation: s.validation }) } };`)))
   .add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [col(21), 640], {
    resource: 'email',
    operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}',
    toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Approve invoice ' + $json.doc.doc_id + ' (' + ($json.extraction.extraction.vendor_name || 'unknown vendor') + ')' }}",
    message: '={{ $json.review_message }}',
    responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Post to accounting', disapproveLabel: 'Do not post' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Canal de aprobación: email (Mailpit en local). Para Slack, cambiar este nodo por Slack → Send and Wait; el resto no cambia. Timeout = no se contabiliza. Esta versión aprueba o rechaza: no edita campos.' })
   .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [col(22), 640], code(embed(
    [{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Review Message').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: solo un "sí" explícito cuenta. Timeout o respuesta ambigua = no se contabiliza.' })
   .add('Approved?', 'n8n-nodes-base.if', 2.2, [col(23), 640], ifEquals('={{ $json.human.status }}', 'approved_by_human'));

  // ── Escalamiento: la IA falló ──
  w.add('Build Escalation', 'n8n-nodes-base.code', 2, [col(21), 900], code(embed(
    [{ file: 'invoice', exports: ['escalationMessage'] }],
    `const s = $input.item.json;
return { json: { ...s, escalation_message: escalationMessage({ doc: s.doc, gate: s.gate }) } };`)))
   .add('Notify Human', 'n8n-nodes-base.emailSend', 2.1, [col(22), 900], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Invoice needs manual entry: ' + $json.doc.doc_id }}",
    emailFormat: 'text', text: '={{ $json.escalation_message }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso a una persona con el motivo. No se contabiliza nada.' })
   .add('Capture Notice', 'n8n-nodes-base.code', 2, [col(23), 900], code(
    `const s = $('Build Escalation').item.json;
const r = $input.item.json;
return { json: { ...s, notice: r.error ? { ok: false, error: JSON.stringify(r.error) } : { ok: true } } };`));

  // ── Estado final + persistencia (con asiento en el libro mock) ──
  w.add('Finalize Status', 'n8n-nodes-base.code', 2, [col(24), 640], code(
    `const s = $input.item.json;
const action = s.gate.action;
const ex = s.extraction.ok ? s.extraction.extraction : null;
const errors = [];
let status;
if (action === 'ignore') status = 'ignored';
else if (action === 'duplicate') status = 'duplicate';
else if (action === 'escalate') { status = 'escalated'; if (s.notice && !s.notice.ok) errors.push('escalation_email_failed: ' + s.notice.error); }
else if (action === 'review' && s.human && s.human.status !== 'approved_by_human') status = s.human.status === 'rejected_by_human' ? 'rejected' : 'no_response';
else {
  const missing = ['vendor_name', 'invoice_number', 'invoice_date', 'total', 'currency'].filter(f => !ex || ex[f] === null || ex[f] === undefined);
  if (s.config.accountingMode === 'live') { status = 'failed'; errors.push('accounting_live_not_built: ACCOUNTING_MODE=live has no adapter yet; nothing was posted. Refusing to use the mock ledger silently.'); }
  else if (missing.length) { status = 'failed'; errors.push('cannot_post_missing_fields: ' + missing.join(',') + '. Approved by a person but incomplete: nothing was posted.'); }
  else status = action === 'auto' ? 'auto_posted' : 'approved_posted';
}
const posted = status === 'auto_posted' || status === 'approved_posted';
const row = {
  doc_id: s.doc.doc_id, filename: s.doc.filename, sender_email: s.doc.sender_email, content_hash: s.fp.content_hash,
  vendor_name: ex ? ex.vendor_name : null, vendor_key: s.fp.vendor_key, invoice_number: ex ? ex.invoice_number : null, invoice_key: s.fp.invoice_key,
  invoice_date: ex ? ex.invoice_date : null, due_date: ex ? ex.due_date : null, currency: ex ? ex.currency : null,
  subtotal: ex ? ex.subtotal : null, tax: ex ? ex.tax : null, total: ex ? ex.total : null, bank_last4: ex ? ex.bank_account_last4 : null,
  line_items: ex ? ex.line_items : [], field_confidence: ex ? ex.field_confidence : {}, evidence: ex ? ex.evidence : {},
  checks: s.validation.issues, reasons: s.gate.reasons, action, status, confidence: s.gate.confidence, extraction_model: ex ? ex.model : null,
  execution_id: String($execution.id), posted, posted_by: action === 'auto' ? 'auto' : 'human',
};
return { json: { ...s, final: { status, errors, posted }, row } };`),
    { notes: 'Todas las rutas terminan aquí: ignorada, duplicada, escalada, rechazada, sin respuesta, contabilizada sola o tras aprobación. En live (sin adaptador) o con campos incompletos NO contabiliza y falla ruidosamente.' });
  pg(w, 'Persist Invoice', [col(25), 640], PERSIST_SQL, '[JSON.stringify($json.row)]',
    { notes: 'Factura, campos, evidencia, confianza, validaciones que fallaron y decisión + asiento del libro (mock de contabilidad) en UNA sentencia atómica. El índice único por proveedor+número es la última red contra el doble pago.' });
  w.add('Invoice Persisted', 'n8n-nodes-base.code', 2, [col(26), 640], code(
    `const s = $('Finalize Status').item.json;
const r = $input.item.json;
if (Number(r.invoice_rows) !== 1) throw new Error('Persist invoice ' + s.doc.doc_id + ' wrote ' + r.invoice_rows + ' rows');
if (Number(r.ledger_rows) !== (s.final.posted ? 1 : 0)) throw new Error('Invoice ' + s.doc.doc_id + ': ledger rows ' + r.ledger_rows + ' do not match status ' + s.final.status);
return { json: { ...s, result: { status: s.final.status, doc_id: s.doc.doc_id, action: s.gate.action, reasons: s.gate.reasons, errors: s.final.errors } } };`));
  markIdempotency(w, {
    position: [col(27), 540], keyExpr: '$json.idem.key',
    statusExpr: "$json.result.status === 'failed' || $json.result.errors.length > 0 ? 'failed' : 'done'",
    resultExpr: '({ status: $json.result.status, action: $json.result.action })',
  });
  w.add('Assert Invoice', 'n8n-nodes-base.code', 2, [col(27), 740], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Invoice ' + r.doc_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar estado y log → Error Handler.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.doc.doc_id', ...o });
  L('Normalize Document', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Idempotency Result', { step: 'document_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  L('Hard Rules', { step: 'hard_rules', status: "$json.pre.injection ? 'skipped' : 'ok'", error: "$json.pre.injection ? 'injection' : ''", detail: '({ injection: $json.pre.injection })' });
  L('Ground & Fingerprint', { step: 'extracted', status: "$json.extraction.ok ? 'ok' : 'failed'", error: "$json.extraction.ok ? '' : $json.extraction.error", detail: '({ is_invoice: $json.extraction.ok ? $json.extraction.extraction.is_invoice : null, model: $json.extraction.ok ? $json.extraction.extraction.model : null, ungrounded: $json.extraction.ok ? $json.extraction.extraction.ungrounded : null })' });
  L('Validate & Gate', { step: 'gated', status: "$json.gate.action === 'auto' ? 'ok' : 'skipped'", error: "$json.gate.action === 'auto' ? '' : $json.gate.reasons.join(',')", detail: '({ action: $json.gate.action, reasons: $json.gate.reasons, confidence: $json.gate.confidence, issues: $json.validation.issues })' });
  L('Apply Human Decision', { step: 'human_decided', status: "$json.human.status === 'approved_by_human' ? 'ok' : 'skipped'", error: "$json.human.status === 'approved_by_human' ? '' : $json.human.status" });
  L('Capture Notice', { step: 'human_notified', status: "$json.notice.ok ? 'ok' : 'failed'", error: "$json.notice.error ?? ''" });
  L('Invoice Persisted', { step: 'completed', status: "$json.result.errors.length > 0 ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## Invoice · Document Processor\nHard rules (code) → AI reads the document and returns each field with its evidence and confidence → code checks every field is really in the document, the arithmetic, dates, duplicates, vendor bank account and limits → gate: post automatically / a person approves / discard (duplicate, not an invoice) / escalate if the AI failed.', [col(0) - 20, -150], col(14), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 1500], 480, 90);

  // ── Conexiones ──
  w.link('Invoice Webhook', 'Config').link('Config', 'Normalize Document').link('Normalize Document', 'Valid Document?')
   .link('Valid Document?', 'Claim Idempotency', 0).link('Valid Document?', 'Respond 400', 1)
   .link('New document?', 'Accepted 202', 0).link('New document?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Hard Rules').link('Hard Rules', 'Extract AI Mode?')
   .link('Extract AI Mode?', 'Build Extraction Request', 0).link('Extract AI Mode?', 'Mock Extract', 1)
   .link('Build Extraction Request', 'Claude Extract').link(exExit, 'Parse Extraction', 1)
   .link('Parse Extraction', 'Ground & Fingerprint').link('Mock Extract', 'Ground & Fingerprint')
   .link('Ground & Fingerprint', 'Lookup Context').link('Lookup Context', 'Validate & Gate').link('Validate & Gate', 'Auto?')
   .link('Auto?', 'Finalize Status', 0).link('Auto?', 'Review?', 1)
   .link('Review?', 'Build Review Message', 0).link('Review?', 'Escalate?', 1)
   .link('Build Review Message', 'Request Approval').link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
   .link('Approved?', 'Finalize Status', 0).link('Approved?', 'Finalize Status', 1)
   .link('Escalate?', 'Build Escalation', 0).link('Escalate?', 'Finalize Status', 1)
   .link('Build Escalation', 'Notify Human').link('Notify Human', 'Capture Notice').link('Capture Notice', 'Finalize Status')
   .link('Finalize Status', 'Persist Invoice').link('Persist Invoice', 'Invoice Persisted')
   .link('Invoice Persisted', 'Mark Idempotency').link('Invoice Persisted', 'Assert Invoice');

  return { file: 'invoice-intake.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
