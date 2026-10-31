const { Workflow, embed, uid, code, ifBool, ifEquals, logBranch, pg, respond } = require('../foundation');
const { TRIAGE } = require('./triage-config');

const WF = 'triage-update';
const col = n => n * 240;

const LOAD_SQL = `SELECT
  (SELECT to_jsonb(t) FROM triage_tickets t WHERE t.ticket_id = $1) AS ticket,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'name', name, 'email', email, 'active', active)) FROM triage_agents), '[]'::jsonb) AS agents`;

// Bloqueo optimista: si otro cambio ocurrió entre la lectura y la escritura (version distinta), no se actualiza nada y el flujo falla.
const PERSIST_SQL = `WITH d AS (SELECT $1::jsonb AS j),
u AS (
  UPDATE triage_tickets t SET
    first_response_at = COALESCE((d.j->'set'->>'first_response_at')::timestamptz, t.first_response_at),
    resolved_at = COALESCE((d.j->'set'->>'resolved_at')::timestamptz, t.resolved_at),
    status = COALESCE(d.j->'set'->>'status', t.status),
    assignee_id = COALESCE(d.j->'set'->>'assignee_id', t.assignee_id),
    assignee_email = COALESCE(d.j->'set'->>'assignee_email', t.assignee_email),
    human_triage = COALESCE((d.j->'set'->>'human_triage')::boolean, t.human_triage),
    version = t.version + 1
  FROM d
  WHERE t.ticket_id = d.j->>'ticket_id' AND t.version = (d.j->>'version')::integer
  RETURNING t.ticket_id
),
e AS (
  INSERT INTO triage_events (ticket_id, event, actor, detail)
  SELECT ticket_id, (SELECT j->>'event' FROM d), (SELECT j->>'by' FROM d), COALESCE((SELECT j->'set' FROM d), '{}'::jsonb) FROM u
  RETURNING id
)
SELECT (SELECT count(*) FROM u) AS updated, (SELECT count(*) FROM e) AS events`;

module.exports = function triageUpdate() {
  const w = Workflow('triageupdate0001', 'Triage · Ticket Update (Auditable)');

  w.add('Update Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 500],
    { httpMethod: 'POST', path: 'triage-update', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Detiene el reloj del SLA: {ticket_id, action: first_response | resolve | reassign, by, agent_id?}. En live lo llamaría el helpdesk al responder o cerrar. Protegido por x-triage-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 500],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: TRIAGE }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Update', 'n8n-nodes-base.code', 2, [col(2), 500], code(embed(
    [{ file: 'triage', exports: ['normalizeUpdate'] }],
    `const item = $input.item.json;
const c = item.config;
const n = normalizeUpdate(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-triage-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { update: n.update, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, acción permitida, quién la hace y, para reasignar, el agente. "now" solo en modo mock.' })
   .add('Valid Update?', 'n8n-nodes-base.if', 2.2, [col(3), 500], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 760], 400, '{ status: "rejected", errors: $json.validation.errors }');

  pg(w, 'Load Ticket', [col(4), 500], LOAD_SQL, '[$json.update.ticket_id]', { alwaysOutputData: true, notes: 'Ticket actual (con su versión) y el equipo.' });
  w.add('Apply Update', 'n8n-nodes-base.code', 2, [col(5), 500], code(embed(
    [{ file: 'triage', exports: ['applyUpdate'] }],
    `const s = $('Normalize Update').item.json;
const r = $input.item.json;
const now = s.update.now || new Date().toISOString();
const EVENT = { first_response: 'first_response', resolve: 'resolved', reassign: 'reassigned' };
const result = applyUpdate(r.ticket, s.update, now, r.agents || []);
return { json: { ...s, ticket_row: r.ticket, now, result, event: EVENT[s.update.action] } };`)),
    { notes: 'DETERMINÍSTICO: primera respuesta y resolución son idempotentes (no pisan la fecha original); un ticket resuelto no se modifica; solo se reasigna a un agente activo.' })
   .add('Updatable?', 'n8n-nodes-base.if', 2.2, [col(6), 500], ifBool('={{ $json.result.ok }}'))
   .add('Not Found?', 'n8n-nodes-base.if', 2.2, [col(7), 800], ifEquals('={{ $json.result.error }}', 'ticket_not_found'))
   .add('Recorded?', 'n8n-nodes-base.if', 2.2, [col(7), 500], ifEquals('={{ $json.result.outcome }}', 'recorded'));
  respond(w, 'Respond 404', [col(8), 900], 404, '{ status: "error", error: $json.result.error, ticket_id: $json.update.ticket_id }');
  respond(w, 'Respond 409', [col(8), 1060], 409, '{ status: "error", error: $json.result.error, ticket_id: $json.update.ticket_id }');
  respond(w, 'Respond Already Recorded', [col(8), 640], 200, '{ status: "already_recorded", ticket_id: $json.update.ticket_id, action: $json.update.action }');

  pg(w, 'Persist Update', [col(8), 400], PERSIST_SQL,
    '[JSON.stringify({ ticket_id: $json.update.ticket_id, version: $json.ticket_row.version, event: $json.event, by: $json.update.by, set: $json.result.set })]',
    { notes: 'Cambio + evento de auditoría (quién y cuándo) en UNA sentencia, con bloqueo optimista por versión.' });
  w.add('Update Persisted', 'n8n-nodes-base.code', 2, [col(9), 400], code(
    `const s = $('Apply Update').item.json;
const r = $input.item.json;
if (Number(r.updated) !== 1 || Number(r.events) !== 1) throw new Error('Update of ticket ' + s.update.ticket_id + ' (' + s.update.action + ') wrote ' + r.updated + ' rows: the ticket changed in between (concurrent_update). Nothing was applied.');
return { json: s };`));
  respond(w, 'Respond Recorded', [col(10), 400], 200, '{ status: "recorded", ticket_id: $json.update.ticket_id, action: $json.update.action, set: $json.result.set }');

  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.update.ticket_id', ...o });
  L('Normalize Update', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Apply Update', { step: 'update_decided', status: "$json.result.ok ? 'ok' : 'failed'", error: "$json.result.ok ? '' : $json.result.error", detail: '({ action: $json.update.action, by: $json.update.by, outcome: $json.result.outcome || null, set: $json.result.set || null })' });
  L('Update Persisted', { step: 'completed', detail: '({ action: $json.update.action, set: $json.result.set })' });

  w.note('## Triage · Ticket Update\nA first response, a resolution or a reassignment stops the SLA clock. Code decides what the update does (idempotent; resolved tickets are frozen; only active agents can be assigned) and records who did it.', [col(0) - 20, -150], col(9), 110);

  w.link('Update Webhook', 'Config').link('Config', 'Normalize Update').link('Normalize Update', 'Valid Update?')
   .link('Valid Update?', 'Load Ticket', 0).link('Valid Update?', 'Respond 400', 1)
   .link('Load Ticket', 'Apply Update').link('Apply Update', 'Updatable?')
   .link('Updatable?', 'Recorded?', 0).link('Updatable?', 'Not Found?', 1)
   .link('Not Found?', 'Respond 404', 0).link('Not Found?', 'Respond 409', 1)
   .link('Recorded?', 'Persist Update', 0).link('Recorded?', 'Respond Already Recorded', 1)
   .link('Persist Update', 'Update Persisted').link('Update Persisted', 'Respond Recorded');

  return { file: 'triage-update.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
