const { Workflow, embed, CRED, uid, code, ifBool, switchBy, logBranch, pg } = require('../foundation');
const { ONB } = require('./onboarding-config');

const WF = 'onboarding-signed';
const col = n => n * 240;
// onboarding.js usa ./schedule y onbpages.js usa ./review: deben registrarse antes o el nodo falla al cargar en n8n
const LIBS = exports_ => [{ file: 'schedule', exports: [] }, { file: 'onboarding', exports: exports_.onboarding || [] }, { file: 'review', exports: [] }, { file: 'onbpages', exports: exports_.pages || [] }];
// Cabeceras de la página: sin scripts ni recursos externos, sin caché, formularios solo hacia este mismo origen.
const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Content-Security-Policy', value: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  { name: 'Cache-Control', value: 'no-store' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] };

const LOAD_SQL = `SELECT (SELECT to_jsonb(k) FROM onb_contracts k WHERE k.client_id = $1) AS contract, (SELECT to_jsonb(c) FROM onb_clients c WHERE c.client_id = $1) AS client_row`;

// La firma es atómica y de un solo uso: el token debe coincidir, la firma no existir y el contrato no haber caducado.
const SIGN_SQL = `WITH k AS (UPDATE onb_contracts SET signed_at = $3::timestamptz WHERE client_id = $1 AND token = $2 AND signed_at IS NULL AND expires_at >= $3::timestamptz RETURNING client_id),
c AS (UPDATE onb_clients SET status = 'provisioning', updated_at = now(), version = version + 1 WHERE client_id = $1 AND status = 'awaiting_signature' AND EXISTS (SELECT 1 FROM k) RETURNING client_id),
s AS (INSERT INTO onb_steps (client_id, step, status, execution_id) SELECT client_id, 'signed', 'ok', $4 FROM c ON CONFLICT (client_id, step) DO NOTHING RETURNING client_id),
e AS (INSERT INTO onb_events (client_id, event, actor, detail) SELECT client_id, 'signed', 'client', '{}'::jsonb FROM c RETURNING id)
SELECT (SELECT count(*) FROM c) AS signed`;

// Cada paso del aprovisionamiento es idempotente y deja su registro en onb_steps: repetirlo no duplica nada.
const STEP = (step, detailExpr = "'{}'::jsonb") => `INSERT INTO onb_steps (client_id, step, status, detail, execution_id) VALUES ($1, '${step}', 'ok', ${detailExpr}, $LAST)
  ON CONFLICT (client_id, step) DO UPDATE SET status = 'ok', error = NULL, detail = EXCLUDED.detail, execution_id = EXCLUDED.execution_id, created_at = now() RETURNING client_id`;
const FOLDER_SQL = `WITH a AS (INSERT INTO onb_assets (client_id, folder) VALUES ($1, $2) ON CONFLICT (client_id) DO NOTHING RETURNING client_id),
s AS (${STEP('folder', "jsonb_build_object('folder', $2::text)").replace('$LAST', '$3')})
SELECT (SELECT count(*) FROM s) AS recorded`;
const PROJECT_SQL = `WITH p AS (INSERT INTO onb_projects (project_id, client_id, name) VALUES ($1, $1, $2) ON CONFLICT (project_id) DO NOTHING RETURNING project_id),
t AS (INSERT INTO onb_tasks (client_id, title, due_date, owner_role, source) SELECT $1, x->>'title', (x->>'due_date')::date, x->>'owner_role', x->>'source' FROM jsonb_array_elements($3::jsonb) x
      ON CONFLICT (client_id, title) DO NOTHING RETURNING id),
s AS (${STEP('project', "jsonb_build_object('tasks', jsonb_array_length($3::jsonb))").replace('$LAST', '$4')})
SELECT (SELECT count(*) FROM s) AS recorded, (SELECT count(*) FROM t) AS tasks_created`;
const CRM_SQL = `WITH u AS (UPDATE onb_clients SET crm_stage = $2, updated_at = now() WHERE client_id = $1 RETURNING client_id),
s AS (${STEP('crm', "jsonb_build_object('stage', $2::text)").replace('$LAST', '$3')})
SELECT (SELECT count(*) FROM s) AS recorded`;
const SEQUENCE_SQL = `WITH o AS (INSERT INTO onb_outbox (client_id, kind, send_after) SELECT $1, x->>'kind', (x->>'send_after')::timestamptz FROM jsonb_array_elements($2::jsonb) x
      ON CONFLICT (client_id, kind) DO NOTHING RETURNING id),
s AS (${STEP('sequence', "jsonb_build_object('messages', jsonb_array_length($2::jsonb))").replace('$LAST', '$3')})
SELECT (SELECT count(*) FROM s) AS recorded, (SELECT count(*) FROM o) AS scheduled`;
// El aviso al equipo se registra DESPUÉS de enviarse: si el correo falla, el paso queda "failed" y el cliente no se activa.
const TEAM_SQL = `INSERT INTO onb_steps (client_id, step, status, error, execution_id) VALUES ($1, 'team_notified', CASE WHEN $2::boolean THEN 'ok' ELSE 'failed' END, NULLIF($3, ''), $4)
ON CONFLICT (client_id, step) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, execution_id = EXCLUDED.execution_id, created_at = now() RETURNING client_id`;
// Activa solo si los cinco pasos están en ok.
const ACTIVATE_SQL = `WITH u AS (UPDATE onb_clients SET status = 'active', updated_at = now(), version = version + 1
  WHERE client_id = $1 AND status IN ('provisioning', 'provisioning_failed')
    AND (SELECT count(*) FROM onb_steps WHERE client_id = $1 AND step IN ('folder', 'project', 'crm', 'sequence', 'team_notified') AND status = 'ok') = 5 RETURNING client_id),
e AS (INSERT INTO onb_events (client_id, event, actor, detail) SELECT client_id, 'activated', 'system', '{}'::jsonb FROM u RETURNING id)
SELECT (SELECT count(*) FROM u) AS activated,
       COALESCE((SELECT string_agg(step, ',' ORDER BY step) FROM onb_steps WHERE client_id = $1 AND status <> 'ok'), '') AS not_ok`;

module.exports = function onboardingSigned() {
  const w = Workflow('onboardingsign001', 'Onboarding · Signature & Setup (Auditable)');

  // ── Página de firma (GET): solo MUESTRA el contrato ──
  w.add('Sign Page (GET)', 'n8n-nodes-base.webhook', 2, [col(0), 120],
    { httpMethod: 'GET', path: 'onboarding-sign', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'El enlace del correo abre esta página. Un GET (un escáner de correo, una vista previa) NUNCA firma: solo muestra el contrato.' })
   .add('Page Config', 'n8n-nodes-base.set', 3.4, [col(1), 120], { mode: 'raw', jsonOutput: JSON.stringify({ config: ONB }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Query', 'n8n-nodes-base.code', 2, [col(2), 120], code(
    `const s = $input.item.json;
const q = s.query || {};
return { json: { config: s.config, client_id: typeof q.client_id === 'string' ? q.client_id.slice(0, 64) : '', token: typeof q.token === 'string' ? q.token.slice(0, 128) : '' } };`));
  pg(w, 'Load For Page', [col(3), 120], LOAD_SQL, '[$json.client_id]', { alwaysOutputData: true, notes: 'Contrato y cliente.' });
  w.add('Render Page', 'n8n-nodes-base.code', 2, [col(4), 120], code(embed(LIBS({ onboarding: ['verifySign'], pages: ['renderSignPage', 'signStatus'] }),
    `const s = $('Parse Query').item.json;
const r = $input.item.json;
const v = verifySign(r.contract, r.client_row, s.token, new Date().toISOString());
if (v.ok && v.outcome === 'sign') return { json: { html: renderSignPage({ company: r.client_row.company, contractText: r.contract.text, clientId: s.client_id, token: s.token, actionUrl: s.config.baseUrl + '/onboarding-sign-submit' }), http_status: 200 } };
const st = signStatus(v.ok ? 'already_signed' : v.error);
return { json: { html: st.html, http_status: st.status } };`)),
    { notes: 'DETERMINÍSTICO: token válido y contrato por firmar → muestra el contrato y el botón; si no, un mensaje claro sin filtrar datos.' })
   .add('Respond Page', 'n8n-nodes-base.respondToWebhook', 1.4, [col(5), 120],
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.http_status || 200 }}', responseHeaders: HTML_HEADERS } });

  // ── Firma (POST) ──
  w.add('Sign Submit (POST)', 'n8n-nodes-base.webhook', 2, [col(0), 520],
    { httpMethod: 'POST', path: 'onboarding-sign-submit', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Botón "I agree and sign" de la página. En live lo sustituye el webhook del proveedor de firma electrónica (contrato SIN verificar).' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 520], { mode: 'raw', jsonOutput: JSON.stringify({ config: ONB }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Submit', 'n8n-nodes-base.code', 2, [col(2), 520], code(
    `const s = $input.item.json;
const b = s.body || {};
const c = s.config;
let now = new Date().toISOString();
if (c.allowTimeOverride && typeof b.now === 'string' && Number.isFinite(Date.parse(b.now))) now = new Date(b.now).toISOString();
return { json: { config: c, client_id: typeof b.client_id === 'string' ? b.client_id.slice(0, 64) : '', token: typeof b.token === 'string' ? b.token.slice(0, 128) : '', now } };`),
    { notes: 'Acepta formulario o JSON. "now" solo en mock.' });
  pg(w, 'Load Contract', [col(3), 520], LOAD_SQL, '[$json.client_id]', { alwaysOutputData: true, notes: 'Contrato (token, caducidad, firma) y cliente.' });
  w.add('Verify Signature', 'n8n-nodes-base.code', 2, [col(4), 520], code(embed(LIBS({ onboarding: ['verifySign'] }),
    `const s = $('Parse Submit').item.json;
const r = $input.item.json;
return { json: { ...s, contract: r.contract, client_row: r.client_row, verify: verifySign(r.contract, r.client_row, s.token, s.now) } };`)),
    { notes: 'DETERMINÍSTICO: token igual al del contrato (uno vacío nunca coincide), no caducado y el cliente esperando la firma. Repetir una firma es idempotente; una firma a medias se REANUDA.' })
   .add('Outcome?', 'n8n-nodes-base.switch', 3.2, [col(5), 520], switchBy("={{ $json.verify.ok ? $json.verify.outcome : 'error' }}", ['sign', 'resume', 'already_signed', 'error']));
  pg(w, 'Sign Atomic', [col(6), 360], SIGN_SQL, '[$json.client_id, $json.token, $json.now, String($execution.id)]',
    { alwaysOutputData: true, notes: 'La firma es atómica y de un solo uso: token igual, sin firma previa, sin caducar. Pasa el cliente a "provisioning" y deja el evento, en UNA sentencia.' });
  w.add('Render Signed', 'n8n-nodes-base.code', 2, [col(7), 360], code(embed(LIBS({ pages: ['signStatus'] }),
    `const s = $('Verify Signature').item.json;
const signed = Number($input.item.json.signed) === 1;
const st = signStatus(signed ? 'signed' : 'already_signed');
return { json: { ...s, html: st.html, http_status: st.status, proceed: signed } };`)),
    { notes: 'Si dos firmas llegan a la vez, solo una gana; la otra recibe "ya firmado" y no repite el aprovisionamiento.' })
   .add('Render Resume', 'n8n-nodes-base.code', 2, [col(6), 600], code(embed(LIBS({ pages: ['signStatus'] }),
    `const s = $input.item.json;
const st = signStatus('signed');
return { json: { ...s, html: st.html, http_status: st.status, proceed: true } };`)),
    { notes: 'La firma ya estaba registrada pero el aprovisionamiento no terminó: se reanuda sin firmar otra vez.' })
   .add('Render Other', 'n8n-nodes-base.code', 2, [col(6), 760], code(embed(LIBS({ pages: ['signStatus'] }),
    `const s = $input.item.json;
const st = signStatus(s.verify.ok ? 'already_signed' : s.verify.error);
return { json: { ...s, html: st.html, http_status: st.status, proceed: false } };`)),
    { notes: 'Token inválido (403), caducado (410), cliente desconocido (404), estado no firmable (409) o ya firmado (200): una respuesta clara y no se toca nada.' })
   .add('Respond HTML', 'n8n-nodes-base.respondToWebhook', 1.4, [col(8), 520],
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.http_status || 200 }}', responseHeaders: HTML_HEADERS } })
   .add('Proceed?', 'n8n-nodes-base.if', 2.2, [col(9), 520], ifBool('={{ $json.proceed }}'));

  // ── Aprovisionamiento: cada paso idempotente y registrado ──
  w.add('Plan Provisioning', 'n8n-nodes-base.code', 2, [col(10), 520], code(embed(LIBS({ onboarding: ['planProvisioning', 'sequenceTimes'] }),
    `const s = $input.item.json;
const c = s.client_row;
const client = { client_id: c.client_id, company: c.company, package: c.package, start_date: c.start_date };
const plan = planProvisioning(client, (c.summary && c.summary.requirements) || [], s.config);
const sequence = sequenceTimes(s.now, c.start_date, s.config);
return { json: { ...s, client, plan, sequence } };`)),
    { notes: 'DETERMINÍSTICO: carpeta, proyecto, tareas de la plantilla del paquete más las que salen de las notas (solo requisitos con cita verificada), fechas en días laborables con festivos, etapa de CRM y secuencia de bienvenida.' });
  pg(w, 'Step · Folder', [col(11), 520], FOLDER_SQL, "[$json.client_id, $json.plan.folder, String($execution.id)]", { notes: 'Carpeta del cliente (mock de Drive). Idempotente.' });
  pg(w, 'Step · Project and tasks', [col(12), 520], PROJECT_SQL, "[$('Plan Provisioning').item.json.client_id, $('Plan Provisioning').item.json.plan.project.name, JSON.stringify($('Plan Provisioning').item.json.plan.tasks), String($execution.id)]", { notes: 'Proyecto y tareas (mock del gestor de proyectos). Una tarea con el mismo título no se duplica.' });
  pg(w, 'Step · CRM', [col(13), 520], CRM_SQL, "[$('Plan Provisioning').item.json.client_id, $('Plan Provisioning').item.json.plan.crm_stage, String($execution.id)]", { notes: 'Etapa del CRM a "Onboarding".' });
  pg(w, 'Step · Welcome sequence', [col(14), 520], SEQUENCE_SQL, "[$('Plan Provisioning').item.json.client_id, JSON.stringify($('Plan Provisioning').item.json.sequence), String($execution.id)]", { notes: 'Programa bienvenida, seguimiento y recordatorio del arranque. Los envía onboarding-sequence respetando bajas y horario.' });
  w.add('Build Team Notice', 'n8n-nodes-base.code', 2, [col(15), 520], code(embed(LIBS({ onboarding: ['teamNotice'] }),
    `const s = $('Plan Provisioning').item.json;
return { json: { ...s, notice: teamNotice({ client: s.client_row, plan: s.plan }) } };`)))
   .add('Notify Team', 'n8n-nodes-base.emailSend', 2.1, [col(16), 520], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}', subject: '={{ $json.notice.subject }}',
    emailFormat: 'text', text: '={{ $json.notice.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso al equipo con carpeta, proyecto y tareas. En live: Slack. Si falla, el paso queda "failed" y el cliente NO se activa.' })
   .add('Capture Notice', 'n8n-nodes-base.code', 2, [col(17), 520], code(
    `const s = $('Build Team Notice').item.json;
const r = $input.item.json;
return { json: { ...s, notice_send: { ok: !r.error, error: r.error ? JSON.stringify(r.error) : '' } } };`));
  pg(w, 'Step · Team notified', [col(18), 520], TEAM_SQL, '[$json.client_id, $json.notice_send.ok, $json.notice_send.error, String($execution.id)]', { notes: 'Se registra DESPUÉS de enviar.' });
  pg(w, 'Activate', [col(19), 520], ACTIVATE_SQL, "[$('Plan Provisioning').item.json.client_id]", { alwaysOutputData: true, notes: 'Activa al cliente solo si los cinco pasos están en ok.' });
  w.add('Setup Result', 'n8n-nodes-base.code', 2, [col(20), 520], code(
    `const s = $('Capture Notice').item.json;
const r = $input.item.json;
const activated = Number(r.activated) === 1;
const errors = activated ? [] : ['provisioning_incomplete: steps not ok -> ' + (r.not_ok || 'unknown') + '. The client stays in provisioning; calling the signature again resumes the missing steps.'];
return { json: { ...s, result: { status: activated ? 'active' : 'provisioning', client_id: s.client_id, tasks: s.plan.tasks.length, errors } } };`))
   .add('Assert Setup', 'n8n-nodes-base.code', 2, [col(21), 520], code(
    `const r = $input.item.json.result;
if (r.errors.length > 0) throw new Error('Onboarding ' + r.client_id + ': ' + r.errors.join(' | '));
return { json: r };`),
    { notes: 'Falla ruidosamente si algún paso no quedó en ok → Error Handler. Nada se da por hecho en silencio.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.client_id', ...o });
  L('Verify Signature', { step: 'signature_checked', status: "$json.verify.ok ? 'ok' : 'failed'", error: "$json.verify.ok ? '' : $json.verify.error", detail: '({ verify: $json.verify })' });
  L('Plan Provisioning', { step: 'plan_built', detail: '({ folder: $json.plan.folder, tasks: $json.plan.tasks.length, sequence: $json.sequence.map(m => m.kind) })' });
  L('Capture Notice', { step: 'team_notified', status: "$json.notice_send.ok ? 'ok' : 'failed'", error: '$json.notice_send.error' });
  L('Setup Result', { step: 'completed', status: "$json.result.errors.length ? 'failed' : 'ok'", error: "$json.result.errors.join(' | ')", detail: '({ result: $json.result })' });

  w.note('## Onboarding · Signature & Setup\nThe contract page only SHOWS the contract on a GET; signing is a POST with a one-time token. After signing, code sets up the folder, project and tasks, CRM stage and welcome sequence step by step, each idempotent and recorded. The client becomes active only when every step is ok, and calling the signature again resumes whatever is missing.', [col(0) - 20, -150], col(14), 130);

  w.link('Sign Page (GET)', 'Page Config').link('Page Config', 'Parse Query').link('Parse Query', 'Load For Page').link('Load For Page', 'Render Page').link('Render Page', 'Respond Page')
   .link('Sign Submit (POST)', 'Config').link('Config', 'Parse Submit').link('Parse Submit', 'Load Contract').link('Load Contract', 'Verify Signature').link('Verify Signature', 'Outcome?')
   .link('Outcome?', 'Sign Atomic', 0).link('Outcome?', 'Render Resume', 1).link('Outcome?', 'Render Other', 2).link('Outcome?', 'Render Other', 3)
   .link('Sign Atomic', 'Render Signed').link('Render Signed', 'Respond HTML').link('Render Resume', 'Respond HTML').link('Render Other', 'Respond HTML')
   .link('Respond HTML', 'Proceed?').link('Proceed?', 'Plan Provisioning', 0)
   .link('Plan Provisioning', 'Step · Folder').link('Step · Folder', 'Step · Project and tasks').link('Step · Project and tasks', 'Step · CRM').link('Step · CRM', 'Step · Welcome sequence')
   .link('Step · Welcome sequence', 'Build Team Notice').link('Build Team Notice', 'Notify Team').link('Notify Team', 'Capture Notice').link('Capture Notice', 'Step · Team notified')
   .link('Step · Team notified', 'Activate').link('Activate', 'Setup Result').link('Setup Result', 'Assert Setup');

  return { file: 'onboarding-signed.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
