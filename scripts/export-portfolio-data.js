// Exporta el catálogo a la subpágina /n8n del portafolio (Next.js): un JSON bilingüe + las capturas ya comprimidas.
// Una sola fuente de verdad: las cifras salen de workflows/*.json y de los tests, el texto de scripts/site/*.js.
// Uso: node scripts/export-portfolio-data.js [ruta-al-portafolio]   (por defecto ../portfolio-site). Antes: node scripts/build-site.js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, CATALOG, facts } = require('./catalog-data');
const { SYSTEMS, PRINCIPLES } = require('./site/systems');
const { ES, GUARDS, PRINCIPLES_ES, UI } = require('./site/portfolio-content');

const target = path.resolve(process.argv[2] || path.join(ROOT, '..', 'portfolio-site'));
const imgDir = path.join(ROOT, 'docs', 'catalog-site', 'img');
if (!fs.existsSync(path.join(target, 'package.json'))) throw new Error(`not a project folder: ${target}`);
if (!fs.existsSync(imgDir)) throw new Error('docs/catalog-site/img not found: run node scripts/build-site.js first');

const L = (en, es) => ({ en, es });
const bySlug = Object.fromEntries(CATALOG.map(c => [c[0], c]));
const unitTests = Number(execFileSync('node --test "test/*.test.js"', { cwd: ROOT, encoding: 'utf8', shell: true }).match(/ℹ pass (\d+)/)[1]);

const systems = SYSTEMS.map(s => {
  const es = ES[s.slug];
  if (!es) throw new Error(`missing Spanish content for ${s.slug}`);
  const guards = GUARDS[s.slug];
  if (!guards) throw new Error(`missing guards for ${s.slug}`);
  if (es.flow.length !== s.flow.length || es.results.length !== s.results.length || es.live.length !== s.live.length) throw new Error(`Spanish content out of sync for ${s.slug}`);
  const wfs = s.workflows.map(w => ({ w: bySlug[w], f: facts(bySlug[w][1]) }));
  return {
    slug: s.slug, name: s.name, problem: L(s.problem, es.problem), pitch: L(s.pitch, es.pitch),
    flow: s.flow.map(([kinds, title, text], i) => ({ kinds, title: L(title, es.flow[i][0]), text: L(text, es.flow[i][1]) })),
    results: s.results.map(([value, label], i) => ({ value, label: L(label, es.results[i]) })),
    ...(s.footnote ? { footnote: L(s.footnote, es.footnote) } : {}),
    live: s.live.map((t, i) => L(t, es.live[i])),
    guards,
    nodes: wfs.reduce((a, x) => a + x.f.nodes, 0),
    workflows: wfs.map(({ w, f }) => ({ name: w[2], nodes: f.nodes, postgres: f.pg, code: f.code, decisions: f.branches, email: f.email, triggers: f.triggers })),
    images: s.shots.map(([slug, kind], i) => ({ file: `${s.slug}-${i + 1}-${kind}.jpg`, kind, workflow: bySlug[slug][2] })),
    cover: `${s.slug}-cover.jpg`, // generado en el portafolio (scripts/n8n-covers.mjs), no aquí
  };
});

const data = {
  stats: { systems: systems.length, workflows: new Set(SYSTEMS.flatMap(s => s.workflows)).size + 1, unitTests },
  ui: UI,
  principles: PRINCIPLES.map(([t, d, icon], i) => ({ icon, title: L(t, PRINCIPLES_ES[i][0]), text: L(d, PRINCIPLES_ES[i][1]) })),
  systems,
};

// salida
const jsonPath = path.join(target, 'src', 'data', 'n8n-catalog.json');
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
const pubDir = path.join(target, 'public', 'n8n');
fs.mkdirSync(pubDir, { recursive: true });
// Se reemplazan solo las capturas exportadas: las portadas (*-cover.jpg) las genera el portafolio y se conservan.
for (const f of fs.readdirSync(pubDir)) if (!f.endsWith('-cover.jpg')) fs.rmSync(path.join(pubDir, f));
let copied = 0;
for (const s of systems) for (const f of s.images.map(i => i.file)) { fs.copyFileSync(path.join(imgDir, f), path.join(pubDir, f)); copied++; }
console.log(`exported ${systems.length} systems (${unitTests} unit tests, ${data.stats.workflows} workflows) -> ${path.relative(ROOT, jsonPath)}; ${copied} images -> ${path.relative(ROOT, pubDir)}`);
