const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, pg } = require('../foundation');
const { SYNC } = require('./sync-config');

const WF = 'sync-run';
const col = n => n * 240;
const FIELDS = ['name', 'email', 'phone', 'company', 'stage'];
const setFields = tbl => FIELDS.map(f => `${f} = CASE WHEN jsonb_exists(x.fields, '${f}') THEN x.fields->>'${f}' ELSE ${tbl}.${f} END`).join(',\n    ');
const insertFields = `x.fields->>'name', NULLIF(x.fields->>'email', ''), NULLIF(x.fields->>'phone', ''), x.fields->>'company', x.fields->>'stage'`;

// UNA sola sentencia atómica: crea, actualiza (con guarda de carrera), marca duplicados, vincula, registra conflictos/incidencias y el historial.
// Si algo no cuadra con el plan, sync_abort() la aborta ENTERA (nada queda a medias).
const APPLY_SQL = `WITH p AS (SELECT $2::jsonb AS plan),
cc AS (
  INSERT INTO sync_crm_contacts (id, name, email, phone, company, stage)
  SELECT x.new_id, ${insertFields} FROM p, jsonb_to_recordset(p.plan->'creates'->'crm') AS x(new_id text, fields jsonb) RETURNING id
),
cs AS (
  INSERT INTO sync_sheet_rows (id, name, email, phone, company, stage)
  SELECT x.new_id, ${insertFields} FROM p, jsonb_to_recordset(p.plan->'creates'->'sheet') AS x(new_id text, fields jsonb) RETURNING id
),
uc AS (
  UPDATE sync_crm_contacts t SET ${setFields('t')}
  FROM p, jsonb_to_recordset(p.plan->'updates'->'crm') AS x(id text, fields jsonb, expected_updated_at timestamptz)
  WHERE t.id = x.id AND t.updated_at = x.expected_updated_at RETURNING t.id
),
us AS (
  UPDATE sync_sheet_rows t SET ${setFields('t')}
  FROM p, jsonb_to_recordset(p.plan->'updates'->'sheet') AS x(id text, fields jsonb, expected_updated_at timestamptz)
  WHERE t.id = x.id AND t.updated_at = x.expected_updated_at RETURNING t.id
),
dc AS (
  UPDATE sync_crm_contacts t SET merged_into = x.canonical
  FROM p, jsonb_to_recordset(p.plan->'duplicates') AS x(side text, id text, canonical text)
  WHERE x.side = 'crm' AND t.id = x.id AND t.merged_into IS NULL RETURNING t.id
),
ds AS (
  UPDATE sync_sheet_rows t SET duplicate_of = x.canonical
  FROM p, jsonb_to_recordset(p.plan->'duplicates') AS x(side text, id text, canonical text)
  WHERE x.side = 'sheet' AND t.id = x.id AND t.duplicate_of IS NULL RETURNING t.id
),
nl AS (
  INSERT INTO sync_links (crm_id, sheet_id, base, how)
  SELECT x.crm_id, x.sheet_id, x.base, x.how FROM p, jsonb_to_recordset(p.plan->'new_links') AS x(crm_id text, sheet_id text, base jsonb, how text) RETURNING link_id
),
bu AS (
  UPDATE sync_links l SET base = x.base, updated_at = now()
  FROM p, jsonb_to_recordset(p.plan->'base_updates') AS x(link_id bigint, base jsonb)
  WHERE l.link_id = x.link_id RETURNING l.link_id
),
cf AS (
  INSERT INTO sync_conflicts (crm_id, sheet_id, field, crm_value, sheet_value, base_value, crm_updated_at, sheet_updated_at, run_id)
  SELECT x.crm_id, x.sheet_id, x.field, x.crm_value, x.sheet_value, x.base_value, x.crm_updated_at, x.sheet_updated_at, $1
  FROM p, jsonb_to_recordset(p.plan->'conflicts') AS x(crm_id text, sheet_id text, field text, crm_value text, sheet_value text, base_value text, crm_updated_at timestamptz, sheet_updated_at timestamptz)
  ON CONFLICT (crm_id, sheet_id, field) WHERE status = 'open' DO UPDATE SET
    crm_value = EXCLUDED.crm_value, sheet_value = EXCLUDED.sheet_value, base_value = EXCLUDED.base_value,
    crm_updated_at = EXCLUDED.crm_updated_at, sheet_updated_at = EXCLUDED.sheet_updated_at, last_seen = now(), run_id = EXCLUDED.run_id
  RETURNING id
),
cr AS (
  UPDATE sync_conflicts c SET status = 'resolved_auto', resolved_at = now()
  WHERE c.status = 'open' AND NOT EXISTS (
    SELECT 1 FROM p, jsonb_to_recordset(p.plan->'conflicts') AS x(crm_id text, sheet_id text, field text)
    WHERE x.crm_id = c.crm_id AND x.sheet_id = c.sheet_id AND x.field = c.field) RETURNING c.id
),
is_ AS (
  INSERT INTO sync_issues (key, kind, detail, run_id)
  SELECT x.key, x.kind, x.detail, $1 FROM p, jsonb_to_recordset(p.plan->'issues') AS x(key text, kind text, detail jsonb)
  ON CONFLICT (key) DO UPDATE SET detail = EXCLUDED.detail, last_seen = now(), resolved_at = NULL, run_id = EXCLUDED.run_id
  RETURNING key
),
ir AS (
  UPDATE sync_issues i SET resolved_at = now()
  WHERE i.resolved_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM p, jsonb_to_recordset(p.plan->'issues') AS x(key text) WHERE x.key = i.key) RETURNING i.key
),
ch AS (
  INSERT INTO sync_changes (run_id, side, action, entity_id, field, old_value, new_value, source_id)
  SELECT $1, x.side, x.action, x.entity_id, x.field, x.old_value, x.new_value, x.source_id
  FROM p, jsonb_to_recordset(p.plan->'changes') AS x(side text, action text, entity_id text, field text, old_value text, new_value text, source_id text) RETURNING id
)
SELECT
  (SELECT count(*) FROM cc) AS created_crm, (SELECT count(*) FROM cs) AS created_sheet,
  (SELECT count(*) FROM uc) AS updated_crm, (SELECT count(*) FROM us) AS updated_sheet,
  (SELECT count(*) FROM dc) + (SELECT count(*) FROM ds) AS duplicates_marked,
  (SELECT count(*) FROM nl) AS new_links, (SELECT count(*) FROM bu) AS base_updates,
  (SELECT count(*) FROM cf) AS conflicts_open, (SELECT count(*) FROM cr) AS conflicts_auto_resolved,
  (SELECT count(*) FROM ir) AS issues_resolved, (SELECT count(*) FROM ch) AS changes_logged,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('crm_id', x.crm_id, 'sheet_id', x.sheet_id, 'field', x.field, 'crm_value', x.crm_value, 'sheet_value', x.sheet_value))
            FROM p, jsonb_to_recordset(p.plan->'conflicts') AS x(crm_id text, sheet_id text, field text, crm_value text, sheet_value text)
            WHERE NOT EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.status = 'open' AND c.crm_id = x.crm_id AND c.sheet_id = x.sheet_id AND c.field = x.field)), '[]'::jsonb) AS new_conflicts,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', x.kind, 'key', x.key, 'detail', x.detail))
            FROM p, jsonb_to_recordset(p.plan->'issues') AS x(key text, kind text, detail jsonb)
            WHERE NOT EXISTS (SELECT 1 FROM sync_issues i WHERE i.key = x.key AND i.resolved_at IS NULL)), '[]'::jsonb) AS new_issues,
  CASE WHEN (SELECT count(*) FROM cc) <> (p.plan->'stats'->>'created_in_crm')::int
         OR (SELECT count(*) FROM cs) <> (p.plan->'stats'->>'created_in_sheet')::int
         OR (SELECT count(*) FROM uc) <> (p.plan->'stats'->>'updated_in_crm')::int
         OR (SELECT count(*) FROM us) <> (p.plan->'stats'->>'updated_in_sheet')::int
         OR (SELECT count(*) FROM dc) + (SELECT count(*) FROM ds) <> (p.plan->'stats'->>'duplicates_marked')::int
         OR (SELECT count(*) FROM nl) <> (p.plan->'stats'->>'new_links')::int
         OR (SELECT count(*) FROM bu) <> jsonb_array_length(p.plan->'base_updates')
       THEN sync_abort('sync plan was not applied cleanly (a record changed while the sync ran, or a row already existed). Nothing was written; the next run plans again from fresh data.')
       ELSE 0 END AS integrity
FROM p`;

const READ_SQL = `SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) FROM (SELECT id, name, email, phone, company, stage, updated_at FROM sync_crm_contacts WHERE merged_into IS NULL) c) AS crm,
  (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM (SELECT id, name, email, phone, company, stage, updated_at FROM sync_sheet_rows WHERE duplicate_of IS NULL) s) AS sheet,
  (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.link_id), '[]'::jsonb) FROM (SELECT link_id, crm_id, sheet_id, base FROM sync_links) l) AS links`;

const LOCK_SQL = `INSERT INTO idempotency_keys (key, workflow, execution_id, status) VALUES ('sync-lock', 'sync-run', $1, 'processing')
ON CONFLICT (key) DO UPDATE SET execution_id = EXCLUDED.execution_id, status = 'processing', claimed_at = now(), finished_at = NULL, attempts = idempotency_keys.attempts + 1
WHERE idempotency_keys.status <> 'processing' OR idempotency_keys.claimed_at < now() - make_interval(secs => $2::int)
RETURNING key`;
const RELEASE_SQL = "UPDATE idempotency_keys SET status = 'done', finished_at = now() WHERE key = 'sync-lock' AND execution_id = $1";

module.exports = function syncRun() {
  const w = Workflow('syncrun00000001', 'Sync · CRM ↔ Sheets Run (Auditable)');

  // ── Disparo: cada 15 min o a demanda ──
  w.add('Schedule 15 min', 'n8n-nodes-base.scheduleTrigger', 1.2, [col(0), 100],
    { rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] } },
    { notes: 'Cada 15 minutos. Sin clave de idempotencia por ventana: el plan converge (una segunda corrida sin cambios no escribe nada) y el bloqueo evita corridas solapadas.' })
   .add('Manual Trigger (webhook)', 'n8n-nodes-base.webhook', 2, [col(0), 320],
    { httpMethod: 'POST', path: 'sync-run', responseMode: 'lastNode', options: {} },
    { webhookId: uid(), notes: 'Para demos y pruebas: POST /webhook/sync-run con la cabecera x-sync-token. Devuelve el resultado de la corrida.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 200],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SYNC }, null, 2), includeOtherFields: true, options: {} })
   .add('Prepare Run', 'n8n-nodes-base.code', 2, [col(2), 200], code(
    `const item = $input.item.json;
const c = item.config;
const isWebhook = item.headers !== undefined;
const errors = [];
if (isWebhook && item.headers['x-sync-token'] !== c.internalToken) errors.push('bad_token');
return { json: { config: c, run_id: String($execution.id), trigger: isWebhook ? 'webhook' : 'schedule', validation: { ok: errors.length === 0, errors } } };`))
   .add('Valid Request?', 'n8n-nodes-base.if', 2.2, [col(3), 200], ifBool('={{ $json.validation.ok }}'))
   .add('Rejected', 'n8n-nodes-base.code', 2, [col(4), 600], code(`return { json: { status: 'rejected', errors: $input.item.json.validation.errors } };`),
    { notes: 'Token inválido: no se lee ni se escribe nada.' });

  // ── Una corrida a la vez ──
  pg(w, 'Acquire Lock', [col(4), 200], LOCK_SQL, '[$json.run_id, $json.config.lockSeconds]',
    { alwaysOutputData: true, notes: 'Bloqueo atómico (PRIMARY KEY) con vencimiento: si una corrida muere, el bloqueo se libera solo. Sin fila de vuelta = ya hay una corrida en curso.' });
  w.add('Lock Result', 'n8n-nodes-base.code', 2, [col(5), 200], code(
    `const s = $('Prepare Run').item.json;
const row = $input.item.json.key ? $input.item.json : null;
return { json: { ...s, lock: { acquired: row !== null } } };`))
   .add('Locked?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifBool('={{ $json.lock.acquired }}'))
   .add('Busy', 'n8n-nodes-base.code', 2, [col(7), 600], code(`return { json: { status: 'busy', run_id: $input.item.json.run_id, message: 'Another sync run is in progress; this one did nothing.' } };`),
    { notes: 'No es un error: la corrida en curso ya hará el trabajo.' })
   .add('Live Mode?', 'n8n-nodes-base.if', 2.2, [col(7), 200], ifEquals('={{ $json.config.mode }}', 'live'));

  // ── Modo live: NO construido → falla ruidosamente, nunca cae a mock en silencio ──
  pg(w, 'Release Lock (live)', [col(8), 560], RELEASE_SQL, '[$json.run_id]');
  w.add('Live Not Built', 'n8n-nodes-base.code', 2, [col(9), 560], code(
    `throw new Error('SYNC_MODE=live is not built: the live CRM (GoHighLevel) and Google Sheets adapters do not exist yet. Refusing to fall back to the mock adapters silently.');`),
    { notes: 'Frontera del adaptador: aquí irían las lecturas/escrituras reales. Hasta que existan, el flujo se niega a correr.' });

  // ── Leer ambos lados (frontera del adaptador mock) ──
  pg(w, 'Read Both Sides (mock adapter)', [col(8), 100], READ_SQL, null,
    { notes: 'ADAPTADOR MOCK: lee CRM y hoja desde Postgres (sin duplicados ya marcados). En live serían GHL y Google Sheets.' });
  w.add('Build Plan', 'n8n-nodes-base.code', 2, [col(9), 100], code(embed(
    [{ file: 'sync', exports: ['planSync'] }],
    `const s = $('Lock Result').item.json;
const r = $input.item.json;
const plan = planSync({ crm: r.crm, sheet: r.sheet, links: r.links, defaultCountry: s.config.defaultCountry, nameThreshold: s.config.nameThreshold });
return { json: { ...s, plan } };`)),
    { notes: 'DETERMINÍSTICO, sin IA y sin escribir: normaliza, detecta duplicados, vincula, hace la fusión de tres vías y devuelve el plan completo (más conflictos e incidencias).' });

  pg(w, 'Apply Plan', [col(10), 100], APPLY_SQL, '[$json.run_id, JSON.stringify($json.plan)]',
    { onError: 'continueErrorOutput', notes: 'ESCRITURA atómica en una sola sentencia + historial de cada cambio. Si un registro cambió mientras corría el sync, aborta TODO y la próxima corrida replanifica. Si falla, se libera el bloqueo y se alerta.' });
  pg(w, 'Release Lock (apply failed)', [col(11), 420], RELEASE_SQL, "[$('Build Plan').item.json.run_id]");
  w.add('Apply Failed', 'n8n-nodes-base.code', 2, [col(12), 420], code(
    `const e = $('Apply Plan').first().json.error;
throw new Error('Sync apply failed and wrote NOTHING (atomic): ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500));`),
    { notes: 'Falla ruidosamente → Error Handler. La sentencia fue atómica: no quedó nada a medias, y el bloqueo ya se liberó.' });
  w.add('Applied', 'n8n-nodes-base.code', 2, [col(11), 100], code(
    `const s = $('Build Plan').item.json;
const r = $input.item.json;
if (Number(r.integrity) !== 0) throw new Error('Sync integrity check failed for run ' + s.run_id);
const applied = { created_crm: Number(r.created_crm), created_sheet: Number(r.created_sheet), updated_crm: Number(r.updated_crm), updated_sheet: Number(r.updated_sheet), duplicates_marked: Number(r.duplicates_marked), new_links: Number(r.new_links), base_updates: Number(r.base_updates), conflicts_open: Number(r.conflicts_open), conflicts_auto_resolved: Number(r.conflicts_auto_resolved), issues_resolved: Number(r.issues_resolved), changes_logged: Number(r.changes_logged) };
return { json: { ...s, applied, new_conflicts: r.new_conflicts || [], new_issues: r.new_issues || [] } };`));

  pg(w, 'Release Lock', [col(12), 100], RELEASE_SQL, "[$('Applied').item.json.run_id]", { notes: 'Libera el bloqueo (si la corrida falla antes, vence solo).' });
  pg(w, 'Ensure Review Link', [col(13), 100],
    `WITH ex AS (SELECT review_id, token FROM sync_reviews WHERE expires_at > now() + interval '1 day' ORDER BY created_at DESC LIMIT 1),
ins AS (
  INSERT INTO sync_reviews (review_id, token, expires_at)
  SELECT 'rv' || substr(md5(random()::text), 1, 12), md5(random()::text || clock_timestamp()::text), now() + interval '7 days'
  WHERE NOT EXISTS (SELECT 1 FROM ex) AND EXISTS (SELECT 1 FROM sync_conflicts WHERE status = 'open') RETURNING review_id, token
)
SELECT review_id, token FROM ins UNION ALL SELECT review_id, token FROM ex LIMIT 1`, null,
    { alwaysOutputData: true, notes: 'Link de revisión de conflictos (vence en 7 días); se reutiliza mientras siga vigente.' });
  w.add('Build Notice', 'n8n-nodes-base.code', 2, [col(14), 100], code(embed(
    [{ file: 'sync', exports: ['buildNotice'] }],
    `const s = $('Applied').item.json;
const r = $input.item.json;
const link = r.review_id ? s.config.reviewUrl + '?review=' + r.review_id + '&token=' + r.token : null;
const notify = s.new_conflicts.length > 0 || s.new_issues.length > 0;
const notice = notify ? buildNotice({ stats: s.plan.stats, newIssues: s.new_issues, newConflicts: s.new_conflicts, reviewLink: s.new_conflicts.length ? link : null, dataLabel: s.config.dataLabel }) : null;
return { json: { ...s, notify, review_link: link, notice } };`)),
    { notes: 'Solo avisa de lo NUEVO (conflictos e incidencias recién vistos), para no repetir el mismo aviso cada 15 minutos.' })
   .add('Notify?', 'n8n-nodes-base.if', 2.2, [col(15), 100], ifBool('={{ $json.notify }}'))
   .add('Send Notice Email', 'n8n-nodes-base.emailSend', 2.1, [col(16), 0], {
    resource: 'email', operation: 'send',
    fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}',
    subject: "={{ 'Sync needs a look: ' + $json.new_conflicts.length + ' conflict(s), ' + $json.new_issues.length + ' item(s)' }}",
    emailFormat: 'both', text: '={{ $json.notice.text }}', html: '={{ $json.notice.html }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso a una persona. El link lleva a la página de conflictos (el flujo no resuelve nada solo).' })
   .add('Capture Notice', 'n8n-nodes-base.code', 2, [col(17), 0], code(
    `const s = $('Build Notice').item.json;
const r = $input.item.json;
return { json: { ...s, notice_sent: !r.error, notice_error: r.error ? JSON.stringify(r.error) : null } };`))
   .add('Final Result', 'n8n-nodes-base.code', 2, [col(18), 100], code(
    `const s = $input.item.json;
return { json: { status: 'ok', run_id: s.run_id, trigger: s.trigger, stats: s.plan.stats, applied: s.applied, new_conflicts: s.new_conflicts.length, new_issues: s.new_issues.length, notified: s.notice_sent === true, review_link: s.review_link } };`));
  w.add('Assert Notice', 'n8n-nodes-base.code', 2, [col(18), -180], code(
    `const s = $input.item.json;
if (s.notice_sent === false) throw new Error('Sync run ' + s.run_id + ' finished and wrote its changes, but the notice email failed: ' + s.notice_error + '. Open conflicts/items are in sync_conflicts and sync_issues.');
return { json: { ok: true } };`),
    { notes: 'Falla ruidosamente DESPUÉS de dejar todo guardado: un aviso que no llegó no puede quedar en silencio.' });

  // ── Log por paso ──
  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.run_id', ...o });
  L('Lock Result', { step: 'lock', status: "$json.lock.acquired ? 'ok' : 'skipped'", error: "$json.lock.acquired ? '' : 'another_run_in_progress'", detail: '({ trigger: $json.trigger })' });
  L('Build Plan', { step: 'plan_built', detail: '({ stats: $json.plan.stats, writes: $json.plan.writes })' });
  L('Applied', { step: 'plan_applied', detail: '({ applied: $json.applied })' });
  L('Build Notice', { step: 'notice_built', status: "$json.notify ? 'ok' : 'skipped'", detail: '({ notify: $json.notify, new_conflicts: $json.new_conflicts.length, new_issues: $json.new_issues.length })' });
  L('Capture Notice', { step: 'notice_sent', status: "$json.notice_sent ? 'ok' : 'failed'", error: "$json.notice_error ?? ''", detail: '({})' });

  w.note('## Sync · CRM ↔ Sheets Run\nEvery 15 min: lock → read both sides → PLAN (pure code, no AI) → apply atomically → notify only about what is new. Never deletes, never overwrites a field both sides changed: it becomes a conflict for a person.', [col(0) - 20, -330], col(10), 130)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches. Every change is also in sync_changes (before / after).', [col(0) - 20, 780], 480, 90);

  w.link('Schedule 15 min', 'Config').link('Manual Trigger (webhook)', 'Config').link('Config', 'Prepare Run').link('Prepare Run', 'Valid Request?')
   .link('Valid Request?', 'Acquire Lock', 0).link('Valid Request?', 'Rejected', 1)
   .link('Acquire Lock', 'Lock Result').link('Lock Result', 'Locked?')
   .link('Locked?', 'Live Mode?', 0).link('Locked?', 'Busy', 1)
   .link('Live Mode?', 'Release Lock (live)', 0).link('Live Mode?', 'Read Both Sides (mock adapter)', 1)
   .link('Release Lock (live)', 'Live Not Built')
   .link('Read Both Sides (mock adapter)', 'Build Plan').link('Build Plan', 'Apply Plan').link('Apply Plan', 'Applied', 0).link('Apply Plan', 'Release Lock (apply failed)', 1).link('Release Lock (apply failed)', 'Apply Failed')
   .link('Applied', 'Release Lock').link('Release Lock', 'Ensure Review Link').link('Ensure Review Link', 'Build Notice').link('Build Notice', 'Notify?')
   .link('Notify?', 'Send Notice Email', 0).link('Notify?', 'Final Result', 1)
   .link('Send Notice Email', 'Capture Notice').link('Capture Notice', 'Final Result').link('Capture Notice', 'Assert Notice');

  return { file: 'sync-run.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
