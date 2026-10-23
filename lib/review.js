// Revisión por lead: la página que muestra los borradores REALES (ya generados) y la lógica que procesa lo que el dueño decide.
// Todo dato de CRM/lead es no confiable: se escapa SIEMPRE. Si algo es ambiguo, se salta (falla cerrado).
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Estilos compartidos (sistema de diseño: panel denso, azul + acento ámbar, foco visible, sin fuentes ni scripts externos).
const BASE_CSS = `
:root{--bg:#f8fafc;--surface:#fff;--fg:#0f172a;--muted:#475569;--border:#cbd5e1;--primary:#1e40af;--on-primary:#fff;--accent:#b45309;--accent-bg:#fef3c7;--ok:#166534;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--ring:#1e40af;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--surface:#111a2e;--fg:#e2e8f0;--muted:#94a3b8;--border:#2a3a5c;--primary:#60a5fa;--on-primary:#0b1220;--accent:#fbbf24;--accent-bg:#3a2a07;--ok:#86efac;--ok-bg:#0f2f1b;--bad:#fca5a5;--bad-bg:#3b1313;--ring:#93c5fd}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--primary)}
.skip{position:absolute;left:-999px;top:8px;background:var(--primary);color:var(--on-primary);padding:8px 12px;border-radius:6px;z-index:10}.skip:focus{left:8px}
:focus-visible{outline:3px solid var(--ring);outline-offset:2px}
header.top{border-bottom:1px solid var(--border);background:var(--surface)}
.wrap{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 4px}h2{font-size:1.05rem;margin:0}
.sub{color:var(--muted);margin:0;font-size:.95rem}
.banner{display:inline-block;background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:2px 10px;font-size:.8rem;font-weight:700;letter-spacing:.04em}
.mono{font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:.85rem}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.chip{border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:2px 12px;font-size:.9rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin:12px 0}
.card.muted{opacity:.92;border-style:dashed}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:.8rem;font-weight:700}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--accent-bg);color:var(--accent)}
label{display:block;font-weight:600;margin:10px 0 4px;font-size:.92rem}
textarea{width:100%;min-height:96px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;resize:vertical}
fieldset{border:0;padding:0;margin:10px 0 0;display:flex;gap:10px;flex-wrap:wrap}
legend{position:absolute;left:-999px}
.choice{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--surface);margin:0;font-weight:600}
.choice input{width:18px;height:18px;accent-color:var(--primary);cursor:pointer}
.choice:has(input:checked){border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}
.note{color:var(--muted);font-size:.88rem;margin:6px 0 0}
button.primary{min-height:48px;padding:0 24px;border:0;border-radius:8px;background:var(--primary);color:var(--on-primary);font:inherit;font-weight:700;cursor:pointer;transition:filter .15s}
button.primary:hover{filter:brightness(1.1)}
.bar{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);padding:12px 16px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${BASE_CSS}</style></head><body>${body}</body></html>`;

function renderReviewPage(ctx) {
  const { batch, drafts, submitUrl, dataLabel } = ctx;
  const ready = drafts.filter(d => d.status === 'pending_review');
  const blocked = drafts.filter(d => d.status === 'blocked');
  const failed = drafts.filter(d => d.status === 'failed');

  const card = d => {
    const head = `<div class="row"><div><h2>${esc(d.contact_name)}</h2><p class="sub">${esc(d.email || '')}${d.company ? ' · ' + esc(d.company) : ''}</p></div>
      <div><span class="pill warn">Touch ${esc(d.touch)} · ${d.kind === 'follow_up' ? 'follow-up' : 'new'}</span></div></div>`;
    if (d.status !== 'pending_review') {
      return `<section class="card muted" aria-label="${esc(d.contact_name)} (not sent)">${head}
        <p class="note"><span class="pill bad">${d.status === 'failed' ? 'Failed' : 'Blocked'}</span> ${esc(d.blocked_reason || 'no reason recorded')}. This contact will not be messaged in this batch.</p></section>`;
    }
    return `<section class="card" aria-label="${esc(d.contact_name)}">${head}
      <label for="b_${esc(d.id)}">Message to send (edit if you want)</label>
      <textarea id="b_${esc(d.id)}" name="b_${esc(d.id)}" rows="4">${esc(d.body_core)}</textarea>
      <p class="note">An opt-out line is added automatically. Links and price promises are not allowed. ${esc(d.send_note || '')}</p>
      <fieldset><legend>Decision for ${esc(d.contact_name)}</legend>
        <label class="choice"><input type="radio" name="d_${esc(d.id)}" value="send" checked> Send</label>
        <label class="choice"><input type="radio" name="d_${esc(d.id)}" value="skip"> Skip</label>
      </fieldset></section>`;
  };

  const body = `<a class="skip" href="#review">Skip to review</a>
<header class="top"><div class="wrap">
  <div class="row"><h1>Review revival batch</h1>${dataLabel ? `<span class="banner">${esc(dataLabel)}</span>` : ''}</div>
  <p class="sub">Batch <span class="mono">${esc(batch.batch_id)}</span> · expires ${esc(batch.expires_at)}. Nothing is sent until you submit. Anything you skip, or leave unclear, is not sent.</p>
  <div class="chips" role="list"><span class="chip" role="listitem">${ready.length} ready</span><span class="chip" role="listitem">${blocked.length + failed.length} blocked or failed</span><span class="chip" role="listitem">${drafts.length} total</span></div>
</div></header>
<main id="review" class="wrap">
  ${ready.length ? `<form method="post" action="${esc(submitUrl)}"><input type="hidden" name="batch" value="${esc(batch.batch_id)}"><input type="hidden" name="token" value="${esc(batch.token)}">
    ${drafts.map(card).join('')}
    <div class="bar"><div class="wrap row"><span class="note">${ready.length} message${ready.length === 1 ? '' : 's'} to decide.</span><button class="primary" type="submit">Submit decisions</button></div></div></form>`
    : `${drafts.map(card).join('')}<p class="card">There is nothing to send in this batch.</p>`}
</main>`;
  return page('Review revival batch', body);
}

// form: body del POST (claves d_<id> y b_<id>). Devuelve una decisión por cada borrador PENDIENTE del lote; nada más.
function applyReview(drafts, form, finalize) {
  const decisions = [];
  const summary = { approved: 0, skipped: 0, edited: 0, rejected_edits: [] };
  for (const d of drafts.filter(x => x.status === 'pending_review')) {
    const wantsSend = form[`d_${d.id}`] === 'send';
    const raw = form[`b_${d.id}`];
    const core = (typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : String(d.body_core || '').trim());
    const skip = (reason) => { decisions.push({ id: d.id, status: 'skipped', body_core: d.body_core, body: d.body || null, edited: false, reason }); summary.skipped++; };

    if (!wantsSend) { skip('owner_skipped'); continue; }
    if (!core) { skip('empty_message'); continue; }
    if (core.length > 2000) { summary.rejected_edits.push({ id: d.id, name: d.contact_name, reason: 'edit_rejected:too_long' }); skip('edit_rejected:too_long'); continue; }
    const f = finalize(core);
    if (!f.ok) { const reason = `edit_rejected:${f.issues.join(',')}`; summary.rejected_edits.push({ id: d.id, name: d.contact_name, reason }); skip(reason); continue; }
    const edited = core !== String(d.body_core || '').trim();
    decisions.push({ id: d.id, status: 'approved', body_core: core, body: f.text, edited, reason: null });
    summary.approved++;
    if (edited) summary.edited++;
  }
  return { decisions, summary };
}

function renderResultPage(summary, dataLabel) {
  const rej = summary.rejected_edits || [];
  const body = `<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap"><div class="row"><h1>Decisions recorded</h1>${dataLabel ? `<span class="banner">${esc(dataLabel)}</span>` : ''}</div>
<p class="sub">The approved messages are being sent now, inside each contact's local sending hours.</p></div></header>
<main id="main" class="wrap">
  <div class="chips"><span class="chip"><span class="pill ok">${esc(summary.approved)}</span> approved</span><span class="chip">${esc(summary.edited)} edited</span><span class="chip">${esc(summary.skipped)} skipped</span></div>
  ${rej.length ? `<div class="card"><h2>Edits that were not accepted</h2><p class="note">These messages were skipped because the edited text broke a safety rule (links, price or guarantee promises, or length).</p><ul>${rej.map(r => `<li>${esc(r.name)} — <span class="mono">${esc(r.reason)}</span></li>`).join('')}</ul></div>` : ''}
  <p class="note">You can close this page.</p>
</main>`;
  return page('Decisions recorded', body);
}

function renderMessagePage({ title, message }) {
  return page(title, `<main class="wrap"><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></main>`);
}

module.exports = { esc, BASE_CSS, page, renderReviewPage, applyReview, renderResultPage, renderMessagePage };
