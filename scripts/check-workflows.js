// Verificación estática de workflows/*.json: enlaces rotos, sintaxis del código embebido y orden de ejecución de las ramas laterales.
// Uso: npm run check   (falla con exit 1 si encuentra problemas)
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'workflows');
let problems = 0;
const bad = msg => { console.log('  ✖ ' + msg); problems++; };

for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const w = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const names = new Set(w.nodes.map(n => n.name));
  const y = Object.fromEntries(w.nodes.map(n => [n.name, n.position[1]]));
  const isSide = n => n.startsWith('Log · ') || n.startsWith('Side · ') || n === 'Mark Idempotency' || n === 'Record Outcome';
  console.log(`${file}: ${w.nodes.length} nodes`);

  for (const [from, c] of Object.entries(w.connections)) {
    if (!names.has(from)) bad(`connection from unknown node "${from}"`);
    for (const out of c.main) {
      for (const t of out) if (!names.has(t.node)) bad(`connection to unknown node "${t.node}"`);
      // n8n v1 ejecuta las ramas de una misma salida de ARRIBA a ABAJO: las laterales deben quedar por encima.
      const side = out.filter(t => isSide(t.node));
      const main = out.filter(t => !isSide(t.node));
      for (const s of side) for (const m of main) if (y[s.node] >= y[m.node]) bad(`order risk: "${s.node}" (y=${y[s.node]}) is not above "${m.node}" (y=${y[m.node]})`);
    }
  }
  for (const n of w.nodes.filter(n => n.type.endsWith('.code'))) {
    try { new Function('$input', '$', '$execution', '$runIndex', n.parameters.jsCode); } catch (e) { bad(`syntax error in Code node "${n.name}": ${e.message}`); }
  }
  const noInput = w.nodes.filter(n => !/trigger|webhook|stickyNote/i.test(n.type) && !Object.values(w.connections).some(c => c.main.some(o => o.some(t => t.node === n.name))));
  for (const n of noInput) bad(`node without incoming connection: "${n.name}"`);
}
console.log(problems ? `\n${problems} problem(s)` : '\nall checks passed');
process.exit(problems ? 1 : 0);
