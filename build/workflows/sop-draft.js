const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pg, respond, idempotency, markIdempotency } = require('../foundation');
const { SOP } = require('./sop-config');

const WF = 'sop-draft';
const col = n => n * 240;
const L = exports_ => [{ file: 'sop', exports: exports_ }];

const ANTHROPIC_PARAMS = jsonBody => ({
  method: 'POST',
  url: process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }] },
  sendBody: true, specifyBody: 'json', jsonBody, options: { timeout: 90000 },
});

// Versión anterior publicada (para mostrar qué cambia) y el siguiente número de versión.
const PREV_SQL = `SELECT COALESCE((SELECT max(version) FROM sop_versions WHERE sop_id = $1), 0) + 1 AS next_version,
  (SELECT steps FROM sop_versions WHERE sop_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1) AS prev_steps,
  (SELECT current_version FROM sop_docs WHERE sop_id = $1) AS current_version`;

// Documento + versión + evento en UNA sentencia. El texto fuente NO se guarda (puede traer datos sensibles): solo su md5 y los pasos con su cita.
// Si dos borradores del mismo SOP compiten por el mismo número de versión, la PRIMARY KEY hace fallar al segundo (ruidosamente).
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
doc AS (INSERT INTO sop_docs (sop_id, title, owner_email, department) SELECT j->>'sop_id', j->>'title', j->>'owner_email', NULLIF(j->>'department', '') FROM d ON CONFLICT (sop_id) DO NOTHING RETURNING sop_id),
v AS (INSERT INTO sop_versions (sop_id, version, status, purpose, steps, gaps, doc_text, source_hash, flags, created_at)
      SELECT j->>'sop_id', (j->>'version')::int, j->>'status', j->>'purpose', j->'steps', j->'gaps', j->>'doc_text', md5(j->>'source_text'), j->'flags', (j->>'now')::timestamptz FROM d RETURNING sop_id, version),
e AS (INSERT INTO sop_events (sop_id, version, event, actor, detail) SELECT sop_id, version, 'drafted', 'system', (SELECT j->'flags' FROM d) FROM v RETURNING id)
SELECT (SELECT count(*) FROM v) AS versions`;

// Publicar es atómico: solo una versión pendiente y no más vieja que la vigente; la anterior pasa a superseded en la misma sentencia.
const PUBLISH_SQL = `WITH d AS (SELECT $1::jsonb AS j),
cur AS (SELECT COALESCE((SELECT current_version FROM sop_docs WHERE sop_id = (SELECT j->>'sop_id' FROM d)), 0) AS cv),
pub AS (UPDATE sop_versions v SET status = 'published', approved_by = d.j->>'approved_by', published_at = (d.j->>'now')::timestamptz FROM d
        WHERE v.sop_id = d.j->>'sop_id' AND v.version = (d.j->>'version')::int AND v.status = 'pending_review' AND (SELECT cv FROM cur) <= v.version RETURNING v.sop_id, v.version),
sup AS (UPDATE sop_versions v SET status = 'superseded' FROM d WHERE v.sop_id = d.j->>'sop_id' AND v.status = 'published' AND v.version <> (d.j->>'version')::int AND EXISTS (SELECT 1 FROM pub) RETURNING v.version),
doc AS (UPDATE sop_docs s SET current_version = pub.version, status = 'published', published_at = (d.j->>'now')::timestamptz, review_reminded_at = NULL, review_escalated_at = NULL,
          title = d.j->>'title', owner_email = d.j->>'owner_email', department = NULLIF(d.j->>'department', ''), updated_at = now() FROM pub, d WHERE s.sop_id = pub.sop_id RETURNING s.sop_id),
stale AS (UPDATE sop_versions v SET status = 'rejected', flags = v.flags || jsonb_build_object('human', 'stale') FROM d
          WHERE v.sop_id = d.j->>'sop_id' AND v.version = (d.j->>'version')::int AND v.status = 'pending_review' AND NOT EXISTS (SELECT 1 FROM pub) AND (SELECT cv FROM cur) > v.version RETURNING v.sop_id, v.version),
e AS (INSERT INTO sop_events (sop_id, version, event, actor, detail)
      SELECT sop_id, version, 'published', (SELECT j->>'approved_by' FROM d), jsonb_build_object('superseded', (SELECT count(*) FROM sup)) FROM pub
      UNION ALL SELECT sop_id, version, 'stale_not_published', 'system', '{}'::jsonb FROM stale RETURNING id)
SELECT (SELECT count(*) FROM pub) AS published, (SELECT count(*) FROM sup) AS superseded, (SELECT cv FROM cur) AS current_version`;

const REJECT_SQL = `WITH d AS (SELECT $1::jsonb AS j),
r AS (UPDATE sop_versions v SET status = 'rejected', flags = v.flags || jsonb_build_object('human', d.j->>'human') FROM d WHERE v.sop_id = d.j->>'sop_id' AND v.version = (d.j->>'version')::int AND v.status = 'pending_review' RETURNING v.sop_id, v.version),
e AS (INSERT INTO sop_events (sop_id, version, event, actor, detail) SELECT sop_id, version, 'rejected', 'owner', jsonb_build_object('human', (SELECT j->>'human' FROM d)) FROM r RETURNING id)
SELECT (SELECT count(*) FROM r) AS rejected`;

module.exports = function sopDraft() {
  const w = Workflow('sopdraft0000001', 'SOP · Draft, Review & Publish (Auditable)');

  // ── Entrada + validación + idempotencia ──
  w.add('Start Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 520],
    { httpMethod: 'POST', path: 'sop-draft', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Descripción de un proceso: {sop_id, title, owner_email, department?, source_text}. En live la dispara un formulario o una transcripción de llamada. Protegido por x-sop-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 520], { mode: 'raw', jsonOutput: JSON.stringify({ config: SOP }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Draft', 'n8n-nodes-base.code', 2, [col(2), 520], code(embed(L(['normalizeDraft']),
    `const item = $input.item.json;
const c = item.config;
const n = normalizeDraft(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-sop-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { draft: n.draft, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, título, correo del responsable, departamento conocido, tamaño del texto. "now" solo en mock con token.' })
   .add('Valid Draft?', 'n8n-nodes-base.if', 2.2, [col(3), 520], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 1700], 400, '{ status: "rejected", errors: $json.validation.errors }');
  idempotency(w, { workflow: WF, position: [col(4), 420], paramCount: 2, params: '$json.draft.sop_id, $json.draft.source_text', stateFrom: 'Normalize Draft', check: 'New draft?', keySql: "'sop-draft:' || $1 || ':' || md5($2)" });
  respond(w, 'Duplicate 200', [col(7), 820], 200, '{ status: "duplicate", sop_id: $json.draft.sop_id }');
  respond(w, 'Accepted 202', [col(7), 420], 202, '{ status: "accepted", sop_id: $json.draft.sop_id }');

  // ── Datos sensibles + inyección, ANTES de la IA ──
  w.add('Prepare Source', 'n8n-nodes-base.code', 2, [col(8), 420], code(embed(L(['redactSensitive', 'injectionCheck']),
    `const s = $input.item.json;
const r = redactSensitive(s.draft.source_text);
const now = s.draft.now || new Date().toISOString();
const { source_text, ...draft } = s.draft;
return { json: { ...s, draft, safe_text: r.text, redacted: r.found, injection: injectionCheck(source_text), source_text, now } };`)),
    { notes: 'DETERMINÍSTICO: contraseñas, claves de API y tarjetas (Luhn) se tapan antes de que la IA o la base de datos vean el texto. Un texto que da órdenes al sistema nunca llega al modelo.' })
   .add('Injection?', 'n8n-nodes-base.if', 2.2, [col(9), 420], ifBool('={{ $json.injection }}'))
   .add('Skip AI', 'n8n-nodes-base.code', 2, [col(10), 700], code(
    `const s = $input.item.json;
return { json: { ...s, extract_result: { ok: false, error: 'skipped: the source text tries to give instructions to the system', skipped: true } } };`),
    { notes: 'Fail-closed: no se llama a la IA con un texto que intenta darle órdenes.' })
   .add('Extract AI Mode?', 'n8n-nodes-base.if', 2.2, [col(10), 300], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Extract Request', 'n8n-nodes-base.code', 2, [col(11), 160], code(embed(L(['buildExtractRequest']),
    `const s = $input.item.json;
return { json: { ...s, claude_request: buildExtractRequest(s.safe_text, s.config.model) } };`)),
    { notes: 'El texto va dentro de <source>: es DATO, nunca instrucciones. Cada paso debe traer la frase textual de la que sale.' })
   .add('Mock Extract', 'n8n-nodes-base.code', 2, [col(11), 440], code(embed(L(['mockExtract']),
    `const s = $input.item.json;
return { json: { ...s, extract_result: mockExtract(s.safe_text, s.config) } };`)),
    { notes: 'Sustituto local de Claude: cada frase con un verbo de acción es un paso; "If ..." es una decisión. [[mock:ai_down]] simula la caída del modelo.' });
  const exExit = httpWithBackoff(w, {
    name: 'Claude Extract', position: [col(12), 160], source: 'Build Extract Request', workflow: WF, entity: '$json.draft.sop_id',
    credentials: CRED.anthropic, notes: 'CONECTA AQUÍ: credencial "Anthropic API". Contrato SIN verificar (tool record_sop).',
    params: ANTHROPIC_PARAMS('={{ JSON.stringify($json.claude_request) }}'),
  });
  w.add('Parse Extract', 'n8n-nodes-base.code', 2, [col(15), 160], code(embed(L(['parseExtract']),
    `const { http_response, ...s } = $input.item.json;
return { json: { ...s, extract_result: parseExtract(http_response) } };`)),
    { notes: 'Valida la forma y que cada paso traiga su cita. Si no, falla cerrado.' })

  // ── Verificar citas + calidad ──
   .add('Ground & Check', 'n8n-nodes-base.code', 2, [col(16), 420], code(embed(L(['groundSteps', 'qualityCheck']),
    `const s = $input.item.json;
const r = s.extract_result;
const g = r.ok ? groundSteps(r.result, s.safe_text) : { kept: [], dropped: [] };
const q = qualityCheck(g, s.config);
const blocking = s.injection ? ['injection_suspected'] : !r.ok ? ['ai_failed'] : q.blocking;
return { json: { ...s, grounded: { ok: r.ok, error: r.ok ? null : r.error, purpose: r.ok ? r.result.purpose : '', kept: g.kept, dropped: g.dropped, model: r.ok ? r.result.model : null }, gaps: s.injection || !r.ok ? [] : q.gaps, blocking } };`)),
    { notes: 'DETERMINÍSTICO: solo se conservan los pasos cuya cita está de verdad en el texto (lo que la IA inventó se descarta y queda registrado). Bloquea si hay muy pocos pasos, demasiados descartados, IA caída o inyección; los huecos (sin responsable, duplicados, decisión sin salida) se declaran en el documento.' });
  pg(w, 'Load Previous', [col(17), 420], PREV_SQL, '[$json.draft.sop_id]', { alwaysOutputData: true, notes: 'Número de la nueva versión y pasos de la versión publicada, para mostrar qué cambia.' });
  w.add('Build Version', 'n8n-nodes-base.code', 2, [col(18), 420], code(embed(L(['diffVersions', 'buildDocument']),
    `const s = $('Ground & Check').item.json;
const r = $input.item.json;
const version = Number(r.next_version);
const diff = diffVersions(r.prev_steps || [], s.grounded.kept);
const status = s.blocking.length ? 'needs_input' : 'pending_review';
const doc_text = buildDocument({ ...s.draft, purpose: s.grounded.purpose }, s.grounded.kept, s.gaps, { version, now: s.now, redacted: s.redacted, model: s.grounded.model });
const row = { sop_id: s.draft.sop_id, title: s.draft.title, owner_email: s.draft.owner_email, department: s.draft.department, version, status, purpose: s.grounded.purpose, steps: s.grounded.kept, gaps: s.gaps, doc_text, source_text: s.source_text, now: s.now,
  flags: { blocking: s.blocking, redacted: s.redacted, dropped: s.grounded.dropped, ai_error: s.grounded.error, model: s.grounded.model, previous_version: r.current_version || null } };
return { json: { ...s, version, diff, status, doc_text, row } };`)),
    { notes: 'DETERMINÍSTICO: el documento sale de una PLANTILLA fija (propósito, pasos numerados con responsable y cita, huecos, procedencia). La versión nueva se compara con la publicada.' });
  pg(w, 'Persist Version', [col(19), 420], PERSIST_SQL, '[JSON.stringify($json.row)]',
    { notes: 'Documento, versión y evento de auditoría en UNA sentencia. El texto original no se guarda: solo su md5 y los pasos con su cita.' });
  w.add('Version Persisted', 'n8n-nodes-base.code', 2, [col(20), 420], code(
    `const s = $('Build Version').item.json;
const r = $input.item.json;
if (Number(r.versions) !== 1) throw new Error('Persist version ' + s.row.sop_id + ' v' + s.row.version + ' wrote ' + r.versions + ' rows');
return { json: s };`))
   .add('Needs Input?', 'n8n-nodes-base.if', 2.2, [col(21), 420], ifEquals('={{ $json.status }}', 'needs_input'))

  // ── Sin base para aprobar: se le dice al autor qué falta ──
   .add('Build Needs Input Email', 'n8n-nodes-base.code', 2, [col(22), 640], code(embed(L(['needsInputMessage']),
    `const s = $input.item.json;
return { json: { ...s, mail: needsInputMessage({ draft: s.draft, reasons: s.blocking }) } };`)))
   .add('Send Needs Input', 'n8n-nodes-base.emailSend', 2.1, [col(23), 640], {
    resource: 'email', operation: 'send', fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.mail.to }}', subject: '={{ $json.mail.subject }}',
    emailFormat: 'text', text: '={{ $json.mail.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Mailpit en local. Nada se publica ni se manda a aprobar: el autor recibe el motivo.' })
   .add('Capture Needs Input', 'n8n-nodes-base.code', 2, [col(24), 640], code(
    `const s = $('Build Needs Input Email').item.json;
const r = $input.item.json;
return { json: { ...s, send: { ok: !r.error, error: r.error ? JSON.stringify(r.error) : '' } } };`))

  // ── Humano: aprobar o no publicar ──
   .add('Build Approval Message', 'n8n-nodes-base.code', 2, [col(22), 220], code(embed(L(['approvalMessage']),
    `const s = $input.item.json;
return { json: { ...s, review_message: approvalMessage({ draft: s.draft, version: s.version, steps: s.grounded.kept, gaps: s.gaps, diff: s.diff, redacted: s.redacted, docText: s.doc_text }) } };`)))
   .add('Request Approval', 'n8n-nodes-base.emailSend', 2.1, [col(23), 220], {
    resource: 'email', operation: 'sendAndWait',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.draft.owner_email }}',
    subject: "={{ 'Approve procedure: ' + $json.draft.title + ' (v' + $json.version + ')' }}", message: '={{ $json.review_message }}', responseType: 'approval',
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Publish this version', disapproveLabel: 'Do not publish' } },
    options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.config.approvalTimeoutHours }}', resumeUnit: 'hours' } } },
  }, { credentials: CRED.smtp, notes: 'Canal de aprobación: email al responsable del proceso (Mailpit en local). Para Slack, cambiar este nodo por Slack → Send and Wait. Sin respuesta en 48 h no se publica nada.' })
   .add('Apply Human Decision', 'n8n-nodes-base.code', 2, [col(24), 220], code(embed([{ file: 'decision', exports: ['applyHumanDecision'] }],
    `const state = $('Build Approval Message').item.json;
const h = applyHumanDecision($input.item.json);
return { json: { ...state, human: { ...h, decided_at: new Date().toISOString() } } };`)),
    { notes: 'Falla cerrado: solo un "sí" explícito publica. Timeout o respuesta ambigua = no se publica.' })
   .add('Approved?', 'n8n-nodes-base.if', 2.2, [col(25), 220], ifEquals('={{ $json.human.status }}', 'approved_by_human'));

  pg(w, 'Publish Version', [col(26), 120], PUBLISH_SQL, "[JSON.stringify({ sop_id: $json.draft.sop_id, version: $json.version, title: $json.draft.title, owner_email: $json.draft.owner_email, department: $json.draft.department, approved_by: $json.draft.owner_email, now: $json.now })]",
    { notes: 'Atómico: publica solo si la versión sigue pendiente y no hay una más nueva ya publicada; la anterior pasa a superseded en la misma sentencia.' });
  w.add('Publish Result', 'n8n-nodes-base.code', 2, [col(27), 120], code(
    `const s = $('Apply Human Decision').item.json;
const r = $input.item.json;
return { json: { ...s, published: Number(r.published) === 1, publish_info: { published: Number(r.published), superseded: Number(r.superseded), current_version: Number(r.current_version) } } };`))
   .add('Published?', 'n8n-nodes-base.if', 2.2, [col(28), 120], ifBool('={{ $json.published }}'))
   .add('Build Published Notice', 'n8n-nodes-base.code', 2, [col(29), 40], code(embed(L(['publishedNotice']),
    `const s = $input.item.json;
const link = s.config.baseUrl + '/sop-view?sop_id=' + encodeURIComponent(s.draft.sop_id) + '&version=' + s.version;
return { json: { ...s, mail: publishedNotice({ draft: s.draft, version: s.version, link }) } };`)))
   .add('Send Published Notice', 'n8n-nodes-base.emailSend', 2.1, [col(30), 40], {
    resource: 'email', operation: 'send', fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.mail.to }}', subject: '={{ $json.mail.subject }}',
    emailFormat: 'text', text: '={{ $json.mail.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso al responsable con el enlace a la página. La versión ya está publicada aunque el aviso falle: el fallo queda visible.' })
   .add('Capture Notice', 'n8n-nodes-base.code', 2, [col(31), 40], code(
    `const s = $('Build Published Notice').item.json;
const r = $input.item.json;
return { json: { ...s, send: { ok: !r.error, error: r.error ? JSON.stringify(r.error) : '' } } };`));
  pg(w, 'Reject Version', [col(26), 360], REJECT_SQL, "[JSON.stringify({ sop_id: $json.draft.sop_id, version: $json.version, human: $json.human.status })]",
    { notes: 'Rechazada o sin respuesta: la versión queda rechazada y no se publica. Un rechazo por falta de respuesta permite reenviar el mismo texto.' });

  // ── Cierres ──
  w.add('Final · published', 'n8n-nodes-base.code', 2, [col(32), 40], code(
    `const s = $input.item.json;
const errors = s.send.ok ? [] : ['published_notice_failed: ' + s.send.error + '. The version is published; the owner was not notified.'];
return { json: { ...s, result: { status: 'published', sop_id: s.draft.sop_id, version: s.version, superseded: s.publish_info.superseded, retryable: false, errors } } };`))
   .add('Final · stale', 'n8n-nodes-base.code', 2, [col(29), 200], code(
    `const s = $input.item.json;
return { json: { ...s, result: { status: 'not_published', sop_id: s.draft.sop_id, version: s.version, retryable: false, errors: ['v' + s.version + ' was approved but NOT published: a newer version (v' + s.publish_info.current_version + ') is already published or this version is no longer pending.'] } } };`),
    { notes: 'Una versión vieja aprobada tarde no pisa a una más nueva. Queda visible (falla ruidosamente).' })
   .add('Final · rejected', 'n8n-nodes-base.code', 2, [col(27), 360], code(
    `const s = $('Apply Human Decision').item.json;
const noReply = s.human.status === 'no_human_response';
return { json: { ...s, result: { status: 'rejected', sop_id: s.draft.sop_id, version: s.version, human: s.human.status, retryable: noReply, errors: [] } } };`),
    { notes: 'Sin respuesta: la clave de idempotencia queda "failed" para que se pueda reenviar el mismo texto.' })
   .add('Final · needs input', 'n8n-nodes-base.code', 2, [col(25), 640], code(
    `const s = $input.item.json;
const errors = s.send.ok ? [] : ['needs_input_email_failed: ' + s.send.error];
return { json: { ...s, result: { status: 'needs_input', sop_id: s.draft.sop_id, version: s.version, reasons: s.blocking, retryable: false, errors } } };`));
  markIdempotency(w, { position: [col(33), 380], keyExpr: '$json.idem.key', statusExpr: "$json.result.retryable ? 'failed' : 'done'", resultExpr: '({ status: $json.result.status, version: $json.result.version })' });
  w.add('Assert Draft', 'n8n-nodes-base.code', 2, [col(33), 560], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('SOP ' + r.sop_id + ' (' + r.status + '): ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar el estado y el log escritos → Error Handler.' });

  // ── Log por paso ──
  const G = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.draft.sop_id', ...o });
  G('Normalize Draft', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  G('Idempotency Result', { step: 'draft_claimed', status: "$json.idem.is_new ? 'ok' : 'duplicate'" });
  G('Prepare Source', { step: 'source_checked', status: "$json.injection ? 'skipped' : 'ok'", error: "$json.injection ? 'injection_suspected' : ''", detail: '({ redacted: $json.redacted })' });
  G('Ground & Check', { step: 'steps_extracted', status: "$json.blocking.length ? 'skipped' : 'ok'", error: "$json.blocking.join(',')", detail: '({ kept: $json.grounded.kept.length, dropped: $json.grounded.dropped, gaps: $json.gaps, model: $json.grounded.model })' });
  G('Version Persisted', { step: 'persisted', detail: '({ version: $json.version, status: $json.status })' });
  G('Apply Human Decision', { step: 'human_decided', status: "$json.human.status === 'approved_by_human' ? 'ok' : 'skipped'", error: "$json.human.status === 'approved_by_human' ? '' : $json.human.status" });
  G('Publish Result', { step: 'published', status: "$json.published ? 'ok' : 'failed'", detail: '({ publish: $json.publish_info })' });
  G('Final · published', { step: 'completed', status: "$json.result.errors.length ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });
  G('Final · stale', { step: 'completed', status: "'failed'", error: "$json.result.errors.join(' | ')", name: 'Log · completed (stale)', detail: '({ result: $json.result })' });
  G('Final · rejected', { step: 'completed', name: 'Log · completed (rejected)', detail: '({ result: $json.result })' });
  G('Final · needs input', { step: 'completed', name: 'Log · completed (needs input)', status: "$json.result.errors.length ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## SOP · Draft, Review & Publish\nCode redacts secrets and checks the source, the AI only extracts the steps (each one quoted from the text), code verifies every quote and the quality, a TEMPLATE writes the document, and the process owner approves before anything is published. Versions are atomic: a late approval of an old version never overwrites a newer one.', [col(0) - 20, -150], col(20), 130);

  w.link('Start Webhook', 'Config').link('Config', 'Normalize Draft').link('Normalize Draft', 'Valid Draft?')
   .link('Valid Draft?', 'Claim Idempotency', 0).link('Valid Draft?', 'Respond 400', 1)
   .link('New draft?', 'Accepted 202', 0).link('New draft?', 'Duplicate 200', 1)
   .link('Accepted 202', 'Prepare Source').link('Prepare Source', 'Injection?')
   .link('Injection?', 'Skip AI', 0).link('Injection?', 'Extract AI Mode?', 1)
   .link('Extract AI Mode?', 'Build Extract Request', 0).link('Extract AI Mode?', 'Mock Extract', 1)
   .link('Build Extract Request', 'Claude Extract').link(exExit, 'Parse Extract', 1)
   .link('Parse Extract', 'Ground & Check').link('Mock Extract', 'Ground & Check').link('Skip AI', 'Ground & Check')
   .link('Ground & Check', 'Load Previous').link('Load Previous', 'Build Version').link('Build Version', 'Persist Version').link('Persist Version', 'Version Persisted').link('Version Persisted', 'Needs Input?')
   .link('Needs Input?', 'Build Needs Input Email', 0).link('Needs Input?', 'Build Approval Message', 1)
   .link('Build Needs Input Email', 'Send Needs Input').link('Send Needs Input', 'Capture Needs Input').link('Capture Needs Input', 'Final · needs input')
   .link('Build Approval Message', 'Request Approval').link('Request Approval', 'Apply Human Decision').link('Apply Human Decision', 'Approved?')
   .link('Approved?', 'Publish Version', 0).link('Approved?', 'Reject Version', 1)
   .link('Publish Version', 'Publish Result').link('Publish Result', 'Published?')
   .link('Published?', 'Build Published Notice', 0).link('Published?', 'Final · stale', 1)
   .link('Build Published Notice', 'Send Published Notice').link('Send Published Notice', 'Capture Notice').link('Capture Notice', 'Final · published')
   .link('Reject Version', 'Final · rejected');
  for (const f of ['Final · published', 'Final · stale', 'Final · rejected', 'Final · needs input']) w.link(f, 'Mark Idempotency').link(f, 'Assert Draft');

  return { file: 'sop-draft.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
