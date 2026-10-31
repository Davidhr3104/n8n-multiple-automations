// Genera docs/catalog-site/: sitio estático liviano (índice por problema de negocio + una página por sistema, capturas en JPG).
// Uso: node scripts/build-site.js   (requiere Python con Pillow para comprimir las capturas)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, SHOTS, CATALOG, facts } = require('./catalog-data');
const { SYSTEMS, PRINCIPLES } = require('./site/systems');

const OUT = path.join(ROOT, 'docs', 'catalog-site');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const bySlug = Object.fromEntries(CATALOG.map(c => [c[0], c]));
const KIND = { code: 'Code decides', ai: 'AI reads', person: 'A person' };
const FONTS = 'https://fonts.googleapis.com/css2?family=Newsreader:wght@500;600&family=Roboto:wght@400;500&display=swap';

// ── Resolver capturas y comprimirlas (miniatura para tarjetas + imagen de página) ──
function shotFile(slug, kind, n) {
  const dir = path.join(SHOTS, slug);
  const hit = fs.readdirSync(dir).find(f => f.startsWith(`${kind}-${n}-of-`) && f.endsWith('.png'));
  if (!hit) throw new Error(`screenshot not found: ${slug} ${kind}-${n}`);
  return path.join(dir, hit);
}
const manifest = [];
for (const s of SYSTEMS) {
  s.images = s.shots.map(([slug, kind, n], i) => {
    const name = `${s.slug}-${i + 1}-${kind}.jpg`;
    manifest.push({ src: shotFile(slug, kind, n), dst: path.join(OUT, 'img', name), width: 1600, quality: 72 });
    if (i === 0) manifest.push({ src: shotFile(slug, kind, n), dst: path.join(OUT, 'img', `${s.slug}-thumb.jpg`), width: 720, quality: 70 });
    return { name, kind, wf: bySlug[slug][2] };
  });
}
fs.rmSync(path.join(OUT, 'img'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'systems'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
const mf = path.join(os.tmpdir(), 'catalog-shots-manifest.json');
fs.writeFileSync(mf, JSON.stringify(manifest));
console.log(execFileSync('python', ['-I', '-X', 'utf8', path.join(__dirname, 'compress-shots.py'), mf], { encoding: 'utf8' }).trim());
fs.copyFileSync(path.join(__dirname, 'site', 'site.css'), path.join(OUT, 'assets', 'site.css'));

// ── Cifras reales leídas de los workflows ──
for (const s of SYSTEMS) {
  s.facts = s.workflows.map(w => ({ w: bySlug[w], f: facts(bySlug[w][1]) }));
  s.nodes = s.facts.reduce((a, x) => a + x.f.nodes, 0);
}
const totalWorkflows = new Set(SYSTEMS.flatMap(s => s.workflows)).size + 1; // + Global Error Handler
const unitTests = (() => {
  const out = execFileSync('node --test "test/*.test.js"', { cwd: ROOT, encoding: 'utf8', shell: true });
  const m = out.match(/ℹ pass (\d+)/);
  if (!m) throw new Error('could not read the unit test count');
  return Number(m[1]);
})();

// ── Piezas HTML ──
const ICON = {
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};
const svg = (n, extra = '') => `<svg ${extra} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const chips = kinds => kinds.map(k => `<span class="chip k-${k}"><i></i>${KIND[k]}</span>`).join('');

function page({ title, desc, root, nav, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}"><link rel="stylesheet" href="${root}assets/site.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap"><a class="brand" href="${root}index.html">n8n systems catalog</a>
<nav aria-label="Primary"><a href="${root}index.html#systems"${nav === 'systems' ? ' aria-current="page"' : ''}>Systems</a><a class="opt" href="${root}index.html#principles">How they are built</a><a class="opt" href="${root}index.html#foundation">Reliability</a></nav></div></header>
<main id="main">${body}</main>
<footer class="site"><div class="wrap"><p><b>David Herrera</b> · AI Systems Architect</p>
<p>Built and tested end to end with synthetic data in mock mode. Nothing here is a client result. Each system page lists what is still to be wired to live accounts.</p></div></footer></body></html>`;
}

// ── Índice ──
const cardHtml = (s, i) => `<article class="card"><div class="thumb"><img src="img/${s.slug}-thumb.jpg" alt="n8n canvas of the ${esc(s.name)} workflow" width="720" height="405" loading="lazy"></div>
<div class="body"><span class="rank">${String(i + 1).padStart(2, '0')}</span><h3><a href="systems/${s.slug}.html">${esc(s.problem)}</a></h3>
<p>${esc(s.name)}: ${esc(s.pitch.split('. ')[0])}.</p>
<div class="meta"><span><b>${s.workflows.length}</b> workflow${s.workflows.length > 1 ? 's' : ''}</span><span><b>${s.nodes}</b> nodes</span><span class="go">See how it works →</span></div></div></article>`;

const indexBody = `
<section class="hero"><div class="wrap"><span class="eyebrow">Automation you can audit</span>
<h1>Six systems that keep a person in the loop where the risk is.</h1>
<p class="lead">Built in n8n, Postgres and Claude. In each one, code makes the decisions and AI only reads, drafts and summarizes: what a model says is checked against evidence before anything moves.</p>
<div class="notice">${svg('info', 'width="20" height="20"')}<p>Built and tested end to end with synthetic data in mock mode. Live accounts connect at the edges, and every system page says exactly what is still to wire up.</p></div>
<div class="stats"><div class="stat"><b>${SYSTEMS.length}</b><span>systems, each solving one business problem</span></div><div class="stat"><b>${totalWorkflows}</b><span>n8n workflows, with real canvas captures</span></div><div class="stat"><b>${unitTests}</b><span>unit tests passing on the decision logic</span></div><div class="stat"><b>0</b><span>wrong automatic replies in a 30-ticket synthetic evaluation</span></div></div>
</div></section>
<section class="block" id="systems"><div class="wrap"><header><span class="eyebrow">Choose by problem</span><h2>What do you need to fix?</h2>
<div class="legend" aria-label="Legend"><div>${chips(['code'])} a rule or calculation decides</div><div>${chips(['ai'])} a model reads or drafts, never decides alone</div><div>${chips(['person'])} a human approves or resolves</div></div></header>
<div class="cards">${SYSTEMS.map(cardHtml).join('')}</div></div></section>
<section class="block" id="principles"><div class="wrap"><header><span class="eyebrow">What every system shares</span><h2>Built so that you can trust what it does.</h2><p class="lead">The same six practices run through all of them. They are the reason a system can be left running.</p></header>
<div class="grid3">${PRINCIPLES.map(([t, d, ic]) => `<div class="principle">${svg(ic)}<h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div></div></section>
<section class="block" id="foundation"><div class="wrap"><header><span class="eyebrow">Reliability</span><h2>When something fails, it says so.</h2></header>
<div class="two"><ul class="ticks"><li>Calls to external APIs retry with <b>exponential backoff and jitter</b>: up to 4 attempts, starting at 2 seconds, doubling, capped at 60 seconds. Client errors that cannot succeed are not retried.</li><li>Failed sends and alerts are <b>retried on the next run</b> and fail loudly; they are never marked as done.</li><li>A <b>Global Error Handler</b> workflow receives every failed execution, writes it to Postgres and emails the details.</li></ul>
<div class="panel"><h3>What is verified</h3><p class="muted">The retry decision logic is unit-tested, and the failed-send retry was proven end to end (SMTP down, alert not recorded, delivered once after recovery). The backoff loop around real API calls has not run against live services yet.</p></div></div></div></section>`;

fs.writeFileSync(path.join(OUT, 'index.html'), page({
  title: 'n8n systems catalog · automation you can audit', root: '', nav: 'systems',
  desc: 'Six auditable automation systems built in n8n, Postgres and Claude, tested end to end with synthetic data.', body: indexBody,
}));

// ── Una página por sistema ──
const wfHtml = ({ w, f }) => `<div class="wf"><h3>${esc(w[2])}</h3><p class="muted">${esc(w[3])}</p>
<div class="facts"><span><b>${f.nodes}</b> nodes</span><span><b>${f.pg}</b> Postgres</span><span><b>${f.code}</b> code</span><span><b>${f.branches}</b> decisions</span><span><b>${f.email}</b> email</span><span>Starts from ${f.triggers.map(esc).join(' · ')}</span></div>
<details><summary>Step by step</summary><ol>${w[4].map(x => `<li>${esc(x)}</li>`).join('')}</ol></details></div>`;

SYSTEMS.forEach((s, i) => {
  const prev = SYSTEMS[(i + SYSTEMS.length - 1) % SYSTEMS.length], next = SYSTEMS[(i + 1) % SYSTEMS.length];
  const guards = [...new Set(s.workflows.flatMap(w => bySlug[w][5]))];
  const body = `
<div class="wrap crumbs"><a href="../index.html#systems">← All systems</a></div>
<section class="sys-hero"><div class="wrap"><span class="eyebrow">${esc(s.name)}</span><h1>${esc(s.problem)}</h1><p class="lead">${esc(s.pitch)}</p>
<div class="results">${s.results.map(([b, l]) => `<div class="result"><b>${esc(b)}</b><span>${esc(l)}</span></div>`).join('')}</div>${s.footnote ? `<p class="muted" style="margin-top:12px;max-width:70ch;font-size:.9rem">${esc(s.footnote)}</p>` : ''}</div></section>
<section class="block"><div class="wrap"><header><span class="eyebrow">How it works</span><h2>${s.flow.length} steps, and who decides each one.</h2></header>
<ol class="flow" style="--n:${s.flow.length}">${s.flow.map(([k, t, d]) => `<li><div class="chips">${chips(k)}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol></div></section>
<section class="block"><div class="wrap two"><div><header style="margin-bottom:24px"><span class="eyebrow">Inside n8n</span><h2>${s.workflows.length} workflow${s.workflows.length > 1 ? 's' : ''}</h2></header>${s.facts.map(wfHtml).join('')}</div>
<aside><div class="panel"><h3>Safeguards</h3><ul class="ticks">${guards.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>
<div class="panel" style="margin-top:16px"><h3>Still to wire up</h3><ul class="ticks next">${s.live.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div></aside></div></section>
<section class="block"><div class="wrap"><header><span class="eyebrow">Real captures</span><h2>The system in n8n.</h2><p class="lead">Screenshots of the actual editor and of a real execution, from the local test environment. Click one to open it full size.</p></header>
<div class="shots">${s.images.map(im => `<figure class="shot"><a href="../img/${im.name}"><img src="../img/${im.name}" alt="${im.kind === 'canvas' ? 'n8n editor canvas' : 'A real n8n execution'} of ${esc(im.wf)}" width="1600" height="900" loading="lazy"></a><figcaption>${esc(im.wf)} · ${im.kind === 'canvas' ? 'canvas' : 'a real execution, nodes in green ran'}</figcaption></figure>`).join('')}</div></div></section>
<section class="block"><div class="wrap pager"><a href="${prev.slug}.html"><small>← Previous</small>${esc(prev.name)}</a><a class="r" href="${next.slug}.html"><small>Next →</small>${esc(next.name)}</a></div></section>`;
  fs.writeFileSync(path.join(OUT, 'systems', `${s.slug}.html`), page({ title: `${s.name} · n8n systems catalog`, desc: s.pitch, root: '../', nav: 'systems', body }));
});

const size = d => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`site: ${SYSTEMS.length} system pages + index in ${path.relative(ROOT, OUT)} (${(size(OUT) / 1e6).toFixed(1)} MB total)`);
