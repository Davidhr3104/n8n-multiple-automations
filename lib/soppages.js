// Página de lectura de un SOP publicado. Todo dato (título, pasos, citas) viene de un texto externo: se escapa SIEMPRE.
// Solo se muestran versiones publicadas; un borrador y un SOP que no existe dan la misma respuesta (no se filtra qué hay en revisión).
const { esc, page, renderMessagePage } = require('./review');

function renderSopPage({ title, sopId, version, department, ownerEmail, publishedAt, purpose, steps, gaps, superseded, dataLabel }) {
  const GAP = { no_owner: 'no owner stated in the source', duplicate_step: 'same wording as an earlier step', decision_without_outcome: 'a decision with nothing after it' };
  const li = (s, i) => `<li><p><span class="pill ${s.kind === 'decision' ? 'warn' : s.kind === 'control' ? 'ok' : ''}">${esc(s.kind)}</span> ${esc(s.text)}</p>
<p class="note">Owner: ${esc(s.actor || '(not stated)')}</p><p class="note">Source: “${esc(s.evidence)}”</p></li>`;
  return page(title, `<main class="wrap"><header class="top"><span class="banner">${esc(dataLabel || '')}</span></header>
<div class="card"><h1>${esc(title)}</h1><p class="sub">Version ${esc(version)} · ${esc(department || 'general')} · Owner: ${esc(ownerEmail)} · Published ${esc(String(publishedAt).slice(0, 10))}</p>
${superseded ? '<p><span class="pill bad">Superseded</span> A newer version of this procedure exists.</p>' : ''}
<h2>Purpose</h2><p>${esc(purpose || 'Not stated in the source.')}</p>
<h2>Steps</h2><ol>${steps.map(li).join('')}</ol>
${gaps.length ? `<h2>Gaps found</h2><ul>${gaps.map(g => `<li>Step ${esc(g.step)}: ${esc(GAP[g.type] || g.type)}</li>`).join('')}</ul>` : ''}
<p class="note">Steps were extracted from the source text by an AI model and checked against it. A person approved this version.</p></div></main>`);
}

const STATUS = {
  invalid_request: [400, 'Bad request', 'This link is incomplete.'],
  not_found: [404, 'Not found', 'We could not find this procedure.'],
};
function sopStatus(kind) {
  if (!STATUS[kind]) throw new Error(`unknown sop status: ${kind}`);
  const [status, title, message] = STATUS[kind];
  return { status, html: renderMessagePage({ title, message }) };
}

module.exports = { renderSopPage, sopStatus };
