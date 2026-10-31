const { Workflow, embed, uid, code, pg } = require('../foundation');
const { SOP } = require('./sop-config');

const WF = 'sop-view';
const col = n => n * 240;
// soppages.js usa ./review: debe registrarse antes o el nodo falla al cargar en n8n
const LIBS = exports_ => [{ file: 'review', exports: [] }, { file: 'soppages', exports: exports_ }];
// Cabeceras de la página: sin scripts ni recursos externos, sin caché, sin formularios.
const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Content-Security-Policy', value: "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" },
  { name: 'Cache-Control', value: 'no-store' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] };

// Sin versión: la publicada. Con versión: esa versión si fue publicada alguna vez (publicada o ya reemplazada). Un borrador nunca se ve.
const LOAD_SQL = `SELECT (SELECT to_jsonb(d) FROM sop_docs d WHERE d.sop_id = $1) AS doc,
  (SELECT to_jsonb(v) FROM sop_versions v WHERE v.sop_id = $1
     AND ((NULLIF($2, '') IS NULL AND v.status = 'published') OR (NULLIF($2, '') IS NOT NULL AND v.version = NULLIF($2, '')::int AND v.status IN ('published', 'superseded')))
   ORDER BY v.version DESC LIMIT 1) AS ver`;

module.exports = function sopView() {
  const w = Workflow('sopview00000001', 'SOP · Published Page (Auditable)');

  w.add('View Page (GET)', 'n8n-nodes-base.webhook', 2, [col(0), 120],
    { httpMethod: 'GET', path: 'sop-view', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'GET /webhook/sop-view?sop_id=...&version=... Solo lectura: solo versiones publicadas.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 120], { mode: 'raw', jsonOutput: JSON.stringify({ config: SOP }, null, 2), includeOtherFields: true, options: {} })
   .add('Parse Query', 'n8n-nodes-base.code', 2, [col(2), 120], code(
    `const s = $input.item.json;
const q = s.query || {};
const sop_id = typeof q.sop_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(q.sop_id) ? q.sop_id : '';
const raw = q.version === undefined ? '' : String(q.version);
const version = /^\\d{1,6}$/.test(raw) ? raw : '';
return { json: { config: s.config, sop_id, version, invalid: sop_id === '' || (raw !== '' && version === '') } };`),
    { notes: 'DETERMINÍSTICO: id seguro y versión numérica; si no, 400 sin tocar la base de datos.' });
  pg(w, 'Load SOP', [col(3), 120], LOAD_SQL, '[$json.sop_id, $json.version]', { alwaysOutputData: true, notes: 'Documento y versión publicada (o ya reemplazada).' });
  w.add('Render Page', 'n8n-nodes-base.code', 2, [col(4), 120], code(embed(LIBS(['renderSopPage', 'sopStatus']),
    `const s = $('Parse Query').item.json;
const r = $input.item.json;
if (s.invalid) { const st = sopStatus('invalid_request'); return { json: { html: st.html, http_status: st.status } }; }
if (!r.doc || !r.ver) { const st = sopStatus('not_found'); return { json: { html: st.html, http_status: st.status } }; }
const html = renderSopPage({ title: r.doc.title, sopId: r.doc.sop_id, version: r.ver.version, department: r.doc.department, ownerEmail: r.doc.owner_email, publishedAt: r.ver.published_at, purpose: r.ver.purpose,
  steps: r.ver.steps, gaps: r.ver.gaps, superseded: r.ver.status === 'superseded', dataLabel: s.config.dataLabel });
return { json: { html, http_status: 200 } };`)),
    { notes: 'DETERMINÍSTICO: todo se escapa. Un borrador y un SOP inexistente dan la misma respuesta 404.' })
   .add('Respond Page', 'n8n-nodes-base.respondToWebhook', 1.4, [col(5), 120],
    { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.http_status || 200 }}', responseHeaders: HTML_HEADERS } });

  w.note('## SOP · Published page\nRead-only GET. Shows only published versions (or a superseded one, marked as such). A draft and an unknown id get the same 404.', [col(0) - 20, -150], col(5), 110);

  w.link('View Page (GET)', 'Config').link('Config', 'Parse Query').link('Parse Query', 'Load SOP').link('Load SOP', 'Render Page').link('Render Page', 'Respond Page');

  return { file: 'sop-view.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
