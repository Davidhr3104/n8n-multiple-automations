// Evaluación del Support Reply Agent contra el workflow REAL (n8n local).
// Uso: node scripts/eval-support.js [--no-ingest]
// 1) Carga la KB sintética (dos veces: la segunda debe ser idempotente). 2) Envía las preguntas de test-data/support/eval.json.
// 3) Lee de Postgres lo que decidió el agente y calcula métricas. Escribe docs/evals/support-eval.md.
// Con embeddings simulados (hashing de palabras) el resultado describe el PIPELINE y sus compuertas, no la calidad de un modelo real.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:5678/webhook';
const TOKEN = 'local-dev-token';
const kbDocs = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-data/support/kb.json'), 'utf8'));
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-data/support/eval.json'), 'utf8'));
const run = Date.now().toString(36);

const sql = q => JSON.parse(execSync('docker exec -i postgres psql -U automations -d automations -t -A', { input: `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${q}) t`, encoding: 'utf8' }).trim() || '[]');
const post = async (p, body) => {
  const r = await fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-support-token': TOKEN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ingest() {
  console.log('== KB ingest ==');
  let first = 0; let second = 0;
  for (const d of kbDocs) { const r = await post('support-kb-ingest', { doc_id: d.doc_id, title: d.title, text: d.text }); if (r.status !== 200) throw new Error(`ingest ${d.doc_id}: ${r.status} ${JSON.stringify(r.body)}`); first += r.body.inserted; }
  for (const d of kbDocs) { const r = await post('support-kb-ingest', { doc_id: d.doc_id, title: d.title, text: d.text }); second += r.body.inserted; if (r.body.unchanged !== r.body.chunks) throw new Error(`re-ingest of ${d.doc_id} was not idempotent: ${JSON.stringify(r.body)}`); }
  console.log(`first pass inserted ${first} chunks; second pass inserted ${second} (idempotent)`);
}

async function main() {
  if (!process.argv.includes('--no-ingest')) await ingest();
  console.log(`== Sending ${questions.length} tickets (run ${run}) ==`);
  const ids = {};
  for (const q of questions) {
    const ticket_id = `ev${run}_${q.id}`;
    ids[q.id] = ticket_id;
    const r = await post('support-ticket', { ticket_id, from_email: `${q.id}@customer-demo.com`, from_name: 'Sam Customer', subject: q.subject, body: q.body, thread_id: 'th_' + q.id, message_id: `<${ticket_id}@mail.demo>` });
    if (r.status !== 202) throw new Error(`ticket ${q.id}: ${r.status} ${JSON.stringify(r.body)}`);
    await sleep(500);
  }
  const list = Object.values(ids).map(i => `'${i}'`).join(',');
  let gated = [];
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    gated = sql(`SELECT entity_id, status, error, detail FROM execution_log WHERE workflow = 'support-ticket' AND step = 'gated' AND entity_id IN (${list})`);
    const autoPending = sql(`SELECT count(*) AS n FROM execution_log l WHERE l.workflow = 'support-ticket' AND l.step = 'gated' AND l.entity_id IN (${list}) AND l.detail->>'action' = 'auto' AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.ticket_id = l.entity_id)`)[0].n;
    if (gated.length === questions.length && Number(autoPending) === 0) break;
  }
  if (gated.length !== questions.length) throw new Error(`only ${gated.length}/${questions.length} tickets were decided in time`);
  await sleep(3000);
  const tickets = Object.fromEntries(sql(`SELECT ticket_id, status, reply_text FROM support_tickets WHERE ticket_id IN (${list})`).map(t => [t.ticket_id, t]));
  const byTicket = Object.fromEntries(gated.map(g => [g.entity_id, g.detail]));

  const rows = questions.map(q => {
    const d = byTicket[ids[q.id]];
    const t = tickets[ids[q.id]];
    const action = d.action;
    let outcome;
    if (q.type === 'answerable') {
      if (action !== 'auto') outcome = 'safe_miss';
      else {
        const docOk = (d.cited_docs || []).includes(q.doc);
        const factOk = t && t.reply_text && t.reply_text.toLowerCase().includes(q.fact.toLowerCase());
        outcome = docOk && factOk ? 'correct_auto' : 'WRONG_AUTO';
      }
    } else if (['sensitive', 'action', 'angry'].includes(q.type)) outcome = action === 'escalate' ? 'safe' : action === 'review' ? 'safe_but_drafted' : 'WRONG_AUTO';
    else outcome = action === 'auto' ? 'WRONG_AUTO' : 'safe';
    return { ...q, action, reasons: d.reasons, similarity: d.top_similarity, cited: (d.cited_docs || []).join(','), outcome };
  });

  const stats = split => {
    const r = rows.filter(x => !split || x.split === split);
    const ans = r.filter(x => x.type === 'answerable');
    const other = r.filter(x => x.type !== 'answerable');
    return {
      n: r.length, answerable: ans.length,
      correct_auto: ans.filter(x => x.outcome === 'correct_auto').length,
      safe_miss: ans.filter(x => x.outcome === 'safe_miss').length,
      wrong_auto: r.filter(x => x.outcome === 'WRONG_AUTO').length,
      non_answerable: other.length, handled_safely: other.filter(x => x.outcome !== 'WRONG_AUTO').length,
    };
  };
  const fmt = s => `answerable ${s.correct_auto}/${s.answerable} answered automatically and correctly (${s.safe_miss} sent to a person instead) | non-answerable ${s.handled_safely}/${s.non_answerable} handled safely | WRONG auto-replies: ${s.wrong_auto}`;
  const all = stats(); const dev = stats('dev'); const test = stats('test');

  console.log('\nid   type          action     sim    cited          outcome            reasons');
  for (const r of rows) console.log(`${r.id.padEnd(4)} ${r.type.padEnd(13)} ${r.action.padEnd(9)} ${String(r.similarity ?? '-').padEnd(6)} ${(r.cited || '-').padEnd(14)} ${r.outcome.padEnd(18)} ${r.reasons.join(',')}`);
  console.log(`\nALL  : ${fmt(all)}\nDEV  : ${fmt(dev)}\nTEST : ${fmt(test)}`);

  const md = [
    '# Support Reply Agent — evaluation', '',
    `Run \`${run}\` against the real n8n workflow, mock mode (word-hashing embeddings, extractive drafter), synthetic KB "Demo Store" (${kbDocs.length} documents) and ${questions.length} synthetic tickets.`, '',
    '> These numbers describe the pipeline and its safety gates. They are NOT a measure of a real model: with local embeddings retrieval matches words, not meaning.', '',
    '| Set | Answerable answered automatically AND correctly | Answerable sent to a person (safe miss) | Non-answerable handled safely | Wrong automatic replies |', '|---|---|---|---|---|',
    ...[['All', all], ['Dev (used to tune the similarity threshold)', dev], ['Test (held out)', test]].map(([n, s]) => `| ${n} | ${s.correct_auto}/${s.answerable} | ${s.safe_miss} | ${s.handled_safely}/${s.non_answerable} | ${s.wrong_auto} |`), '',
    'Wrong automatic reply = the agent answered by itself when it should not have, or answered with the wrong source/fact. It is the number that matters most.', '',
    '| id | split | type | action | similarity | cited | outcome | reasons |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.split} | ${r.type} | ${r.action} | ${r.similarity ?? '-'} | ${r.cited || '-'} | ${r.outcome} | ${r.reasons.join(', ')} |`), '',
  ].join('\n');
  fs.mkdirSync(path.join(ROOT, 'docs/evals'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/evals/support-eval.md'), md);
  console.log('\nwritten docs/evals/support-eval.md');
  process.exitCode = all.wrong_auto > 0 ? 1 : 0;
}

main().catch(e => { console.error('EVAL ERROR:', e.message); process.exit(2); });
