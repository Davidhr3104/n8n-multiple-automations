// Genera docs/workflows-catalog.html: una ficha por workflow (qué hace, cómo, salvaguardas, cifras reales leídas de workflows/*.json)
// con sus capturas del canvas de n8n incrustadas. Uso: node scripts/build-catalog.js
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SHOTS, CATALOG, facts } = require('./catalog-data');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');

let cards = '';
let totalShots = 0;
for (const [slug, file, title, summary, steps, guards] of CATALOG) {
  const f = facts(file);
  const dir = path.join(SHOTS, slug);
  const canvas = fs.readdirSync(dir).filter(x => x.startsWith('canvas')).sort();
  const exec = fs.readdirSync(dir).filter(x => x.startsWith('execution')).sort();
  totalShots += canvas.length + exec.length;
  cards += `<section class="card" id="${slug}"><h2>${esc(title)}</h2><p class="lead">${esc(summary)}</p>
<div class="facts"><span><b>${f.nodes}</b> nodes</span><span><b>${f.pg}</b> Postgres</span><span><b>${f.code}</b> code</span><span><b>${f.branches}</b> decisions</span><span><b>${f.email}</b> email</span><span><b>${f.http}</b> HTTP</span></div>
<p class="meta"><b>Starts from:</b> ${f.triggers.map(esc).join(' · ')} &nbsp;|&nbsp; <b>id:</b> <code>${f.id}</code></p>
<div class="cols"><div><h3>How it works</h3><ol>${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div><div><h3>Safeguards</h3><ul>${guards.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
<h3>Canvas in n8n</h3>${canvas.map(c => `<figure><img loading="lazy" alt="${esc(title)} canvas ${c}" src="${b64(path.join(dir, c))}"><figcaption>${esc(c)}</figcaption></figure>`).join('')}
<h3>A real execution</h3>${exec.slice(0, 1).map(c => `<figure><img loading="lazy" alt="${esc(title)} execution" src="${b64(path.join(dir, c))}"><figcaption>${esc(c)} (${exec.length} execution captures in the folder)</figcaption></figure>`).join('')}
</section>`;
}

const toc = CATALOG.map(([slug, , title]) => `<a href="#${slug}">${esc(title)}</a>`).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>n8n workflows catalog</title><style>
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#475569;--card:#fff;--border:#cbd5e1;--primary:#1e40af;--chip:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--border:#2a3a5c;--primary:#93c5fd;--chip:#1e2a45}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:16px}h1{margin:.2em 0}.sub{color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}nav a{background:var(--chip);padding:4px 12px;border-radius:999px;color:var(--fg);text-decoration:none;font-size:.9rem}nav a:hover{outline:2px solid var(--primary)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:20px 0}.lead{font-size:1.05rem}
.facts{display:flex;flex-wrap:wrap;gap:8px}.facts span{background:var(--chip);border-radius:999px;padding:2px 12px;font-size:.9rem}.meta{color:var(--muted);font-size:.9rem}
.cols{display:grid;grid-template-columns:2fr 1fr;gap:20px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
figure{margin:12px 0}img{max-width:100%;height:auto;border:1px solid var(--border);border-radius:8px}figcaption{color:var(--muted);font-size:.8rem}
code{background:var(--chip);padding:1px 6px;border-radius:4px}h3{margin:.8em 0 .3em;font-size:1rem}
</style></head><body><div class="wrap"><h1>n8n workflows catalog</h1>
<p class="sub">${CATALOG.length} workflows, ${totalShots} editor screenshots. Built and tested with synthetic data in mock mode: live Claude, GoHighLevel, Gmail, Google Sheets, Xero and embeddings contracts are not verified. Node counts are read from the workflow files.</p>
<nav>${toc}</nav>${cards}</div></body></html>`;
fs.writeFileSync(path.join(ROOT, 'docs', 'workflows-catalog.html'), html);
console.log(`catalog: ${CATALOG.length} workflows, ${totalShots} screenshots, ${(html.length / 1e6).toFixed(1)} MB`);
