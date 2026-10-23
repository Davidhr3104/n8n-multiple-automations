// Capturas de EVIDENCIA reales (no diagramas): correos de Mailpit y la traza de auditoría de un lead desde Postgres.
// Requiere los contenedores corriendo y datos recientes (scripts/smoke-test.ps1 -Clean -AutoApprove, luego POST /webhook/weekly-report).
// Uso: node scripts/render-evidence.js [carpeta-de-salida]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'n8n-automations-screenshots');
const TMP = path.join(OUT, '.tmp');
const BROWSER = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));
if (!BROWSER) throw new Error('No se encontró Edge ni Chrome');
fs.mkdirSync(TMP, { recursive: true });

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sql = q => JSON.parse(execFileSync('docker', ['exec', 'postgres', 'psql', '-U', 'automations', '-d', 'automations', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim() || 'null');

function shot(url, png, w, h, extra = []) {
  execFileSync(BROWSER, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, '--virtual-time-budget=12000', ...extra, `--screenshot=${png}`, url], { stdio: 'ignore', timeout: 120000 });
  console.log(`${path.basename(png)}  ${fs.existsSync(png) ? Math.round(fs.statSync(png).size / 1024) + ' KB' : 'NO SE GENERÓ'}`);
}

// ── Mailpit: bandeja y correos reales ──
(async () => {
  const msgs = (await (await fetch('http://localhost:8025/api/v1/messages')).json()).messages;
  const find = re => msgs.find(m => re.test(m.Subject));
  shot('http://localhost:8025/', path.join(OUT, '07-mailpit-bandeja.png'), 1500, 950);
  for (const [re, name] of [[/Review needed: Ana/, '08-email-aprobacion-del-lead'], [/Approve first message to Ana/, '09-email-aprobacion-del-vendedor'], [/\[Weekly\]/, '10-email-reporte-semanal'], [/^Re: your inquiry/, '11-email-primer-mensaje-al-lead']]) {
    const m = find(re);
    if (!m) { console.log(`${name}: no hay correo que coincida con ${re}`); continue; }
    shot(`http://localhost:8025/view/${m.ID}`, path.join(OUT, `${name}.png`), 1500, name.includes('reporte') ? 1500 : 1000);
  }

  // ── Postgres: traza de un lead y tabla de resultados ──
  const lead = sql("SELECT json_build_object('id', lead_id, 'name', name, 'email', email) FROM lead_outcomes WHERE email = 'ana@acmecorp.com' LIMIT 1");
  const steps = sql(`SELECT json_agg(r ORDER BY r.id) FROM (SELECT id, to_char(created_at, 'HH24:MI:SS.MS') AS t, step, status, left(coalesce(error, ''), 90) AS error FROM execution_log WHERE entity_id = '${lead.id}') r`);
  const outcomes = sql("SELECT json_agg(r) FROM (SELECT email, coalesce(source, '') AS source, coalesce(tier, '') AS tier, coalesce(score::text, '') AS score, status, coalesce(rep_email, '') AS rep, coalesce(outreach_status, '') AS outreach FROM lead_outcomes ORDER BY received_at) r");
  const pill = s => { const c = { ok: ['#dcfce7', '#166534'], failed: ['#fee2e2', '#991b1b'], waiting: ['#fef3c7', '#92400e'], skipped: ['#e5e7eb', '#374151'], duplicate: ['#e0e7ff', '#3730a3'], retrying: ['#ffedd5', '#9a3412'] }[s] || ['#e5e7eb', '#374151']; return `<span style="background:${c[0]};color:${c[1]};padding:2px 10px;border-radius:99px;font-size:13px;font-weight:600">${esc(s)}</span>`; };
  const page = (title, sub, body) => `<!doctype html><meta charset="utf-8"><style>body{font-family:Segoe UI,Arial,sans-serif;background:#fafaf9;margin:0;padding:40px 48px;color:#18181b}h1{font-size:26px;margin:0 0 4px}p{color:#52525b;margin:0 0 22px;font-size:15px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:8px}th{text-align:left;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#71717a;padding:10px 14px;border-bottom:1px solid #e4e4e7}td{padding:9px 14px;border-bottom:1px solid #f4f4f5;font-size:14px}.m{font-family:Consolas,monospace;color:#52525b}</style><h1>${esc(title)}</h1><p>${esc(sub)}</p>${body}`;
  fs.writeFileSync(path.join(TMP, 'audit.html'), page('Traza de auditoría de un lead', `${lead.name} · ${lead.id} · ${steps.length} pasos registrados en Postgres (execution_log), en orden cronológico`,
    `<table><tr><th>Hora</th><th>Paso</th><th>Estado</th><th>Error</th></tr>${steps.map(s => `<tr><td class="m">${esc(s.t)}</td><td>${esc(s.step)}</td><td>${pill(s.status)}</td><td class="m">${esc(s.error)}</td></tr>`).join('')}</table>`));
  shot('file:///' + path.join(TMP, 'audit.html').replace(/\\/g, '/'), path.join(OUT, '12-traza-de-auditoria-de-un-lead.png'), 1300, 160 + steps.length * 42);
  fs.writeFileSync(path.join(TMP, 'outcomes.html'), page('Resultado de cada lead', 'Tabla lead_outcomes: lo que alimenta el reporte semanal. Datos sintéticos de prueba.',
    `<table><tr><th>Email</th><th>Canal</th><th>Tier</th><th>Score</th><th>Estado</th><th>Vendedor</th><th>Mensaje</th></tr>${outcomes.map(o => `<tr><td>${esc(o.email)}</td><td>${esc(o.source)}</td><td>${esc(o.tier)}</td><td>${esc(o.score)}</td><td>${esc(o.status)}</td><td class="m">${esc(o.rep)}</td><td>${esc(o.outreach)}</td></tr>`).join('')}</table>`));
  shot('file:///' + path.join(TMP, 'outcomes.html').replace(/\\/g, '/'), path.join(OUT, '13-resultados-de-leads.png'), 1400, 190 + outcomes.length * 42);
})().catch(e => { console.error(e); process.exit(1); });
