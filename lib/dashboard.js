// Panel de métricas del revival: HTML estático (sin scripts ni fuentes externas), accesible y con todo dato escapado.
// Las cifras vienen de SQL; aquí solo se calculan porcentajes (con "—" cuando el denominador es 0) y se dibuja.
const { esc, BASE_CSS } = require('./review');

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const num = v => Number(v || 0);
const LABELS = { interested: 'Interested', schedule: 'Wants to schedule', not_interested: 'Not interested', unsubscribe: 'Opt-out', unclear: 'Unclear' };

const DASH_CSS = `
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:16px 0}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.kpi .v{font-size:1.9rem;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.kpi .l{color:var(--muted);font-size:.85rem}
.kpi.alert{border-color:var(--accent)}
section.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin:16px 0}
.cols{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
table{border-collapse:collapse;width:100%;font-size:.92rem}
caption{text-align:left;font-weight:700;padding:0 0 8px;font-size:1rem}
th{text-align:left;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid var(--border)}
td{padding:7px 8px;border-bottom:1px solid var(--border);vertical-align:middle}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{display:block;height:10px;border-radius:5px;background:var(--primary);min-width:2px}
.barcell{width:42%}
.scroll{overflow-x:auto}
nav.period{display:flex;gap:8px;margin:12px 0}
nav.period a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--fg);background:var(--surface);font-weight:600}
nav.period a[aria-current="page"]{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.foot{color:var(--muted);font-size:.85rem;margin:20px 0}
`;

function barTable(caption, head, rows, total) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<div class="scroll"><table><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(head)}</th><th scope="col" class="n">Count</th><th scope="col" class="barcell"><span class="sr">Share</span></th></tr></thead><tbody>
${rows.length ? rows.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${esc(r.n)}</td><td><span class="bar" style="width:${Math.round((r.n / max) * 100)}%" aria-hidden="true"></span></td></tr>`).join('') : '<tr><td colspan="3">Nothing yet.</td></tr>'}
</tbody>${total === undefined ? '' : `<tfoot><tr><th scope="row">Total</th><td class="n">${esc(total)}</td><td></td></tr></tfoot>`}</table></div>`;
}

function renderDashboard(m, opts = {}) {
  const { dataLabel = '' } = opts;
  const c = m.contacts, d = m.drafts, r = m.replies;
  const interested = (r.by_label || []).filter(x => x.label === 'interested' || x.label === 'schedule').reduce((s, x) => s + num(x.n), 0);
  const optOuts = num(c.opted_out);
  const periods = [['7', '7 days'], ['30', '30 days'], ['all', 'All time']];
  const active = m.days === null || m.days === undefined ? 'all' : String(m.days);

  const kpi = (label, value, extra = '', alert = false) => `<div class="kpi${alert ? ' alert' : ''}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}${extra ? ` <span class="note">${esc(extra)}</span>` : ''}</div></div>`;

  const reviewRows = [
    ['Sent', d.sent], ['Approved, waiting to send', d.approved], ['Held for sending hours', d.deferred], ['Waiting for your review', d.pending_review],
    ['Skipped by you', d.skipped], ['Blocked by safety rules', d.blocked], ['Failed', d.failed],
  ].map(([label, n]) => ({ label, n: num(n) }));
  const stateRows = [
    ['In sequence (active)', c.active], ['Sequence completed', c.completed], ['Booking link sent', c.booking_sent], ['Not interested', c.not_interested], ['Opted out', c.opted_out], ['Needs a human', c.needs_review],
  ].map(([label, n]) => ({ label, n: num(n) }));
  const replyRows = (r.by_label || []).map(x => ({ label: LABELS[x.label] || x.label, n: num(x.n) }));
  const touchRows = (m.touches || []).map(t => ({ label: `Touch ${t.touch}`, n: num(t.sent) }));

  const batches = m.batches || [];
  const failures = m.failures || [];
  const body = `<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
  <div class="row"><h1>Revival console</h1>${dataLabel ? `<span class="banner">${esc(dataLabel)}</span>` : ''}</div>
  <p class="sub">Lead revival: what was drafted, reviewed, sent and answered. Updated ${esc(m.generated_at)}.</p>
  <nav class="period" aria-label="Period">${periods.map(([v, l]) => `<a href="?days=${v}"${v === active ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>
</div></header>
<main id="main" class="wrap">
  <div class="grid" role="list">
    ${kpi('Messages sent', num(d.sent))}
    ${kpi('Contacts messaged', num(c.messaged))}
    ${kpi('Reply rate', pct(num(r.contacts_replied), num(c.messaged)), `${num(r.contacts_replied)} of ${num(c.messaged)}`)}
    ${kpi('Interested replies', interested)}
    ${kpi('Booking links sent', num(c.booking_sent), 'not confirmed appointments')}
    ${kpi('Opt-outs', optOuts)}
    ${kpi('Waiting for review', num(d.pending_review), '', num(d.pending_review) > 0)}
    ${kpi('Edited by you', num(d.edited), `${pct(num(d.edited), num(d.sent) + num(d.approved))} of approved`)}
  </div>
  <div class="cols">
    <section class="panel" aria-labelledby="h-review"><h2 id="h-review" class="sub" style="font-weight:700">Review outcome</h2>${barTable('Drafts by outcome', 'Outcome', reviewRows, num(d.total))}</section>
    <section class="panel" aria-labelledby="h-state"><h2 id="h-state" class="sub" style="font-weight:700">Where contacts are</h2>${barTable('Contacts by sequence state', 'State', stateRows)}</section>
    <section class="panel" aria-labelledby="h-touch"><h2 id="h-touch" class="sub" style="font-weight:700">Touches sent</h2>${barTable('Messages sent per touch', 'Touch', touchRows)}</section>
    <section class="panel" aria-labelledby="h-reply"><h2 id="h-reply" class="sub" style="font-weight:700">Replies</h2>${barTable('Replies by type', 'Type', replyRows, num(r.total))}</section>
  </div>
  <section class="panel"><div class="scroll"><table><caption>Recent batches</caption><thead><tr><th scope="col">Batch</th><th scope="col">Status</th><th scope="col" class="n">Drafts</th><th scope="col" class="n">Sent</th><th scope="col" class="n">Skipped</th><th scope="col">Created</th></tr></thead><tbody>
  ${batches.length ? batches.map(b => `<tr><td class="mono">${esc(b.batch_id)}</td><td>${esc(b.status)}</td><td class="n">${esc(b.size)}</td><td class="n">${esc(b.sent)}</td><td class="n">${esc(b.skipped)}</td><td>${esc(b.created_at)}</td></tr>`).join('') : '<tr><td colspan="6">No batches yet.</td></tr>'}
  </tbody></table></div></section>
  <section class="panel"><div class="scroll"><table><caption>Pipeline failures</caption><thead><tr><th scope="col">Step</th><th scope="col" class="n">Failures</th></tr></thead><tbody>
  ${failures.length ? failures.map(f => `<tr><td class="mono">${esc(f.step)}</td><td class="n">${esc(f.n)}</td></tr>`).join('') : '<tr><td colspan="2">No failures in this period.</td></tr>'}
  </tbody></table></div></section>
  <p class="foot">Reply rate counts contacts that replied divided by contacts messaged. "Booking links sent" counts links approved and sent, not confirmed appointments.</p>
</main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Revival console</title><style>${BASE_CSS}${DASH_CSS}.sr{position:absolute;left:-999px}</style></head><body>${body}</body></html>`;
}

module.exports = { renderDashboard, pct };
