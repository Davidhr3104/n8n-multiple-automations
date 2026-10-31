// Página de revisión de conflictos del Sync y la lógica que procesa lo que la persona decide.
// Todo dato de CRM/hoja es no confiable: se escapa SIEMPRE. Sin elección clara = pendiente (falla cerrado, no se toca nada).
const { esc, page } = require('./review');
const { FIELD_LABEL, resolveChoice } = require('./sync');

function renderConflictsPage({ review, conflicts, submitUrl, dataLabel }) {
  const card = c => `<section class="card" aria-label="${esc(FIELD_LABEL[c.field] || c.field)} conflict">
    <div class="row"><div><h2>${esc(FIELD_LABEL[c.field] || c.field)}</h2><p class="sub mono">CRM ${esc(c.crm_id)} · Sheet ${esc(c.sheet_id)}</p></div><span class="pill warn">both sides changed</span></div>
    <div class="chips" role="list">
      <span class="chip" role="listitem"><b>CRM:</b> ${esc(c.crm_value) || '<i>(empty)</i>'}</span>
      <span class="chip" role="listitem"><b>Sheet:</b> ${esc(c.sheet_value) || '<i>(empty)</i>'}</span>
      <span class="chip" role="listitem"><b>Last synced:</b> ${esc(c.base_value) || '<i>(empty)</i>'}</span>
    </div>
    <fieldset><legend>Decision for ${esc(FIELD_LABEL[c.field] || c.field)} (${esc(c.crm_id)})</legend>
      <label class="choice"><input type="radio" name="c_${esc(c.id)}" value="crm"> Keep the CRM value</label>
      <label class="choice"><input type="radio" name="c_${esc(c.id)}" value="sheet"> Keep the Sheet value</label>
      <label class="choice"><input type="radio" name="c_${esc(c.id)}" value="pending" checked> Decide later</label>
    </fieldset></section>`;
  return page('Sync conflicts', `<a class="skip" href="#main">Skip to conflicts</a>
<header class="top"><div class="wrap"><span class="banner">${esc(dataLabel)}</span><h1>Resolve sync conflicts</h1>
<p class="sub">Both systems changed the same field. Nothing was overwritten. Pick which value wins; it is copied to the other system. "Decide later" leaves it untouched.</p></div></header>
<main id="main" class="wrap"><form method="post" action="${esc(submitUrl)}">
<input type="hidden" name="review" value="${esc(review.review_id)}"><input type="hidden" name="token" value="${esc(review.token)}">
${conflicts.length ? conflicts.map(card).join('') : '<section class="card"><p>No open conflicts. Everything is in sync.</p></section>'}
${conflicts.length ? '<div class="bar"><button class="primary" type="submit">Apply my choices</button></div>' : ''}
</form></main>`);
}

// Convierte el formulario en escrituras. Cada una lleva las guardas (updated_at al detectar) para no pisar una edición posterior.
function buildResolution(conflicts, form) {
  const writes = [];
  let pending = 0;
  for (const c of conflicts) {
    const choice = form['c_' + c.id];
    const r = resolveChoice(c, choice);
    if (r.action !== 'copy') { pending++; continue; }
    writes.push({ conflict_id: Number(c.id), choice, write_to: r.write_to, field: c.field, value: r.value, base: r.base, crm_id: c.crm_id, sheet_id: c.sheet_id, crm_updated_at: c.crm_updated_at, sheet_updated_at: c.sheet_updated_at });
  }
  return { writes, summary: { requested: writes.length, pending } };
}

function renderResolvedPage({ resolved, stale, pending, dataLabel }) {
  return page('Sync conflicts resolved', `<header class="top"><div class="wrap"><span class="banner">${esc(dataLabel)}</span><h1>Choices applied</h1></div></header>
<main class="wrap"><section class="card"><p><span class="pill ok">${esc(resolved)} resolved</span> ${stale ? `<span class="pill warn">${esc(stale)} skipped: changed since detection</span>` : ''} <span class="pill">${esc(pending)} left for later</span></p>
<p class="note">Resolved values were copied to the other system and recorded in the change history. Skipped conflicts stay open: the next sync run re-checks them with the fresh values.</p></section></main>`);
}

module.exports = { renderConflictsPage, buildResolution, renderResolvedPage };
