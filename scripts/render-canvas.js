// Dibuja cada workflow de workflows/*.json como diagrama (SVG dentro de HTML) usando las MISMAS posiciones de nodos que en n8n,
// y lo convierte a PNG con Edge/Chrome en modo headless. No toca n8n ni necesita sesión: lee solo los JSON.
// Uso: node scripts/render-canvas.js [carpeta-de-salida]
// OJO: son diagramas generados desde el JSON, NO capturas del editor de n8n.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'n8n-automations-screenshots');
const TMP = path.join(OUT, '.tmp');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) throw new Error('No se encontró Edge ni Chrome para generar los PNG');

const W = 210, H = 72;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isSide = n => n.name.startsWith('Log · ') || n.name.startsWith('Side · ') || n.name === 'Mark Idempotency' || n.name === 'Record Outcome';

const CATS = {
  trigger: ['Disparador', '#0d9488'], respond: ['Respuesta HTTP', '#2dd4bf'], decision: ['Decisión (IF)', '#f59e0b'],
  code: ['Código determinístico', '#64748b'], ai: ['IA (Claude)', '#7c3aed'], api: ['API externa', '#4f46e5'],
  human: ['Aprobación humana', '#e11d48'], email: ['Email', '#0284c7'], db: ['Postgres', '#16a34a'],
  wait: ['Espera / backoff', '#ea580c'], config: ['Config', '#94a3b8'], file: ['Archivo de auditoría', '#92400e'], end: ['Fin', '#cbd5e1'],
};

function category(n) {
  const t = n.type.replace('n8n-nodes-base.', '');
  const p = n.parameters || {};
  if (['webhook', 'scheduleTrigger', 'errorTrigger'].includes(t)) return 'trigger';
  if (t === 'respondToWebhook') return 'respond';
  if (t === 'if') return 'decision';
  if (t === 'code') return 'code';
  if (t === 'httpRequest') return /anthropic|claude/i.test(`${p.url} ${n.name}`) ? 'ai' : 'api';
  if (t === 'emailSend') return p.operation === 'sendAndWait' ? 'human' : 'email';
  if (t === 'postgres') return 'db';
  if (t === 'wait') return 'wait';
  if (t === 'set') return 'config';
  if (t === 'convertToFile' || t === 'readWriteFile') return 'file';
  return 'end';
}

function wrap(text, max) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > max && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  return lines;
}

function render(workflow, mode) {
  const nodes = workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && (mode === 'full' || !isSide(n)));
  const notes = workflow.nodes.filter(n => n.type === 'n8n-nodes-base.stickyNote' && (mode === 'full' || !/Per-step log/.test(n.parameters.content)));
  const byName = Object.fromEntries(nodes.map(n => [n.name, n]));

  const xs = [...nodes.map(n => n.position[0]), ...notes.map(n => n.position[0])];
  const ys = [...nodes.map(n => n.position[1]), ...notes.map(n => n.position[1])];
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...nodes.map(n => n.position[0] + W), ...notes.map(n => n.position[0] + n.parameters.width));
  const maxY = Math.max(...nodes.map(n => n.position[1] + H), ...notes.map(n => n.position[1] + n.parameters.height));
  const PAD = 50, HEAD = 110, FOOT = 90;
  const ox = PAD - minX, oy = HEAD - minY;
  const width = Math.round(maxX - minX + PAD * 2);
  const height = Math.round(maxY - minY + HEAD + FOOT);

  let svg = '';
  for (const n of notes) {
    const [x, y] = [n.position[0] + ox, n.position[1] + oy];
    const { width: w, height: h, content } = n.parameters;
    const lines = wrap(content.replace(/^#+\s*/gm, ''), Math.floor((w - 24) / 6.4));
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#fffbeb" stroke="#f1dfa0" stroke-dasharray="6 4"/>`;
    lines.slice(0, Math.floor((h - 16) / 17)).forEach((l, i) => { svg += `<text x="${x + 12}" y="${y + 24 + i * 17}" font-size="${i === 0 ? 14 : 12}" font-weight="${i === 0 ? 700 : 400}" fill="#78350f">${esc(l)}</text>`; });
  }

  let edges = '';
  for (const [from, c] of Object.entries(workflow.connections)) {
    if (!byName[from]) continue;
    const s = byName[from];
    c.main.forEach((outs, oi) => outs.forEach(t => {
      const d = byName[t.node];
      if (!d) return;
      const sx = s.position[0] + ox + W, sy = s.position[1] + oy + H / 2, tx = d.position[0] + ox, ty = d.position[1] + oy + H / 2;
      const dx = Math.max(60, Math.abs(tx - sx) / 2);
      const side = isSide(d);
      edges += `<path d="M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}" fill="none" stroke="${side ? '#cbd5e1' : '#94a3b8'}" stroke-width="${side ? 1.2 : 1.8}" ${side ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#a${side ? 's' : 'm'})"/>`;
      if (s.type.endsWith('.if') && !side) edges += `<text x="${sx + 12}" y="${sy + (oi === 0 ? -8 : 16)}" font-size="11" font-weight="700" fill="${oi === 0 ? '#15803d' : '#b91c1c'}">${oi === 0 ? 'sí' : 'no'}</text>`;
    }));
  }

  const used = new Set();
  let boxes = '';
  for (const n of nodes) {
    const [label, color] = CATS[category(n)];
    used.add(category(n));
    const x = n.position[0] + ox, y = n.position[1] + oy;
    const lines = wrap(n.name, 23).slice(0, 2);
    const dim = isSide(n);
    boxes += `<g opacity="${dim ? 0.78 : 1}"><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" fill="#fff" stroke="#d4d4d8"/>` +
      `<rect x="${x}" y="${y}" width="9" height="${H}" rx="4" fill="${color}"/>` +
      `<text x="${x + 22}" y="${y + 20}" font-size="10" font-weight="700" letter-spacing=".6" fill="${color}">${esc(label.toUpperCase())}</text>` +
      lines.map((l, i) => `<text x="${x + 22}" y="${y + 40 + i * 17}" font-size="13.5" font-weight="600" fill="#18181b">${esc(l)}</text>`).join('') + '</g>';
  }

  const mainCount = workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && !isSide(n)).length;
  const sideCount = workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && isSide(n)).length;
  const sub = mode === 'main'
    ? `Flujo principal · ${mainCount} nodos (+ ${sideCount} nodos de log/idempotencia ocultos)`
    : `Vista completa · ${mainCount + sideCount} nodos: ${mainCount} de flujo y ${sideCount} de registro (líneas punteadas)`;

  let legend = '', lx = PAD;
  for (const key of used) {
    const [label, color] = CATS[key];
    legend += `<rect x="${lx}" y="${height - 56}" width="14" height="14" rx="3" fill="${color}"/><text x="${lx + 20}" y="${height - 44}" font-size="13" fill="#3f3f46">${esc(label)}</text>`;
    lx += 20 + label.length * 7.4 + 28;
  }

  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Arial, sans-serif">
<defs><marker id="am" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
<marker id="as" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#cbd5e1"/></marker></defs>
<rect width="100%" height="100%" fill="#fafaf9"/>
<text x="${PAD}" y="52" font-size="30" font-weight="700" fill="#18181b">${esc(workflow.name)}</text>
<text x="${PAD}" y="82" font-size="15" fill="#52525b">${esc(sub)}</text>
${svg}${edges}${boxes}${legend}</svg>`;
  return { html: `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fafaf9}svg{display:block}</style>${body}`, width, height };
}

function shot(htmlPath, pngPath, width, height) {
  // headless clásico: --window-size = viewport. Margen extra para evitar recortes y luego no recortamos nada.
  execFileSync(browser, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${width},${height + 120}`, `--screenshot=${pngPath}`, 'file:///' + htmlPath.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 120000 });
}

fs.mkdirSync(TMP, { recursive: true });
const plan = [
  ['lead-intake', 'main', '01-lead-intake-flujo-principal'], ['lead-intake', 'full', '01b-lead-intake-con-logging'],
  ['weekly-report', 'main', '02-weekly-report'],
  ['revival-run', 'main', '03-revival-daily-run'], ['revival-touch', 'main', '04-revival-send-touch'], ['revival-reply', 'main', '05-revival-handle-reply'],
  ['error-handler', 'full', '06-error-handler'],
];
for (const [file, mode, name] of plan) {
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', `${file}.json`), 'utf8'));
  const { html, width, height } = render(wf, mode);
  const htmlPath = path.join(TMP, `${name}.html`);
  const pngPath = path.join(OUT, `${name}.png`);
  fs.writeFileSync(htmlPath, html);
  shot(htmlPath, pngPath, width, height);
  console.log(`${name}.png  ${width}x${height}  ${fs.existsSync(pngPath) ? Math.round(fs.statSync(pngPath).size / 1024) + ' KB' : 'NO SE GENERÓ'}`);

  // Los workflows anchos se parten en tramos legibles (con 250 px de solape) para presentaciones y portafolio.
  if (width > 6000) {
    const PART = 3200, OVERLAP = 250;
    const n = Math.ceil((width - OVERLAP) / (PART - OVERLAP));
    for (let i = 0; i < n; i++) {
      const x0 = Math.min(i * (PART - OVERLAP), width - PART);
      const partHtml = path.join(TMP, `${name}-parte-${i + 1}.html`);
      fs.writeFileSync(partHtml, html.replace('svg{display:block}', `svg{display:block;margin-left:-${x0}px}`));
      const partPng = path.join(OUT, 'por-tramos', `${name}-parte-${i + 1}-de-${n}.png`);
      fs.mkdirSync(path.dirname(partPng), { recursive: true });
      shot(partHtml, partPng, PART, height);
      console.log(`  por-tramos/${path.basename(partPng)}  ${PART}x${height}  ${fs.existsSync(partPng) ? 'ok' : 'NO SE GENERÓ'}`);
    }
  }
}
