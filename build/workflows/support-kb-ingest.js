const { Workflow, embed, CRED, uid, code, ifBool, ifEquals, logBranch, httpWithBackoff, pgKb, respond } = require('../foundation');
const { SUPPORT } = require('./support-config');

const WF = 'support-kb-ingest';
const col = n => n * 240;

module.exports = function supportKbIngest() {
  const w = Workflow('supportkbingest1', 'Support · KB Ingest (Auditable)');

  w.add('Ingest Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 300],
    { httpMethod: 'POST', path: 'support-kb-ingest', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Carga o actualiza UN documento de la base de conocimiento: {doc_id, title, text}. En producción lo dispararía un cron o un cambio en Drive/Notion. Protegido por x-support-token.' })
   .add('Config', 'n8n-nodes-base.set', 3.4, [col(1), 300],
    { mode: 'raw', jsonOutput: JSON.stringify({ config: SUPPORT }, null, 2), includeOtherFields: true, options: {} })
   .add('Validate Document', 'n8n-nodes-base.code', 2, [col(2), 300], code(
    `const item = $input.item.json;
const c = item.config;
const b = item.body || {};
const errors = [];
if (!item.headers || item.headers['x-support-token'] !== c.internalToken) errors.push('bad_token');
if (typeof b.doc_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.doc_id)) errors.push('doc_id');
if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) errors.push('title');
if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 100000) errors.push('text');
return { json: { doc: { doc_id: b.doc_id, title: (b.title || '').trim(), text: b.text }, validation: { ok: errors.length === 0, errors }, config: c } };`))
   .add('Valid Document?', 'n8n-nodes-base.if', 2.2, [col(3), 300], ifBool('={{ $json.validation.ok }}'));
  respond(w, 'Respond 400', [col(4), 700], 400, '{ status: "rejected", errors: $json.validation.errors }');

  // ── Troceo determinístico ──
  w.add('Chunk Document', 'n8n-nodes-base.code', 2, [col(4), 200], code(embed(
    [{ file: 'kb', exports: ['chunkText'] }],
    `const s = $input.item.json;
const chunks = chunkText(s.doc.text, { max: 600 });
return { json: { ...s, chunks, embed_inputs: chunks.map(c => s.doc.title + '\\n' + c.content) } };`)),
    { notes: 'DETERMINÍSTICO: trocea por párrafos (≈600 caracteres) sin partir frases. Cada fragmento lleva un hash de su contenido: lo que no cambió no se vuelve a guardar.' })
   .add('Any Chunks?', 'n8n-nodes-base.if', 2.2, [col(5), 200], ifBool('={{ $json.chunks.length > 0 }}'));
  respond(w, 'Respond 422 (empty)', [col(6), 600], 422, '{ status: "empty_document", doc_id: $json.doc.doc_id }');

  // ── Embeddings: mock (hashing local) o live (proveedor HTTP) ──
  w.add('Embed Mode?', 'n8n-nodes-base.if', 2.2, [col(6), 200], ifEquals('={{ $json.config.aiMode }}', 'live'))
   .add('Build Embeddings Request', 'n8n-nodes-base.code', 2, [col(7), 60], code(embed(
    [{ file: 'kb', exports: ['buildEmbeddingsRequest'] }],
    `const s = $input.item.json;
return { json: { ...s, embeddings_request: buildEmbeddingsRequest(s.embed_inputs, s.config) } };`)))
   .add('Mock Embeddings', 'n8n-nodes-base.code', 2, [col(7), 320], code(embed(
    [{ file: 'kb', exports: ['embedMock'] }],
    `const s = $input.item.json;
return { json: { ...s, embeddings: { ok: true, mode: 'mock', vectors: s.embed_inputs.map(embedMock) } } };`)),
    { notes: 'Sustituto local: vector por hashing de palabras (256 dimensiones). Mide coincidencia de palabras, no significado.' });

  const embExit = httpWithBackoff(w, {
    name: 'Embeddings API', position: [col(8), 60], source: 'Build Embeddings Request', workflow: WF, entity: '$json.doc.doc_id',
    credentials: CRED.embeddings,
    notes: 'CONECTA AQUÍ: proveedor de embeddings (credencial "Embeddings API"). Debe devolver 256 dimensiones por texto. Contrato SIN verificar; la respuesta se valida estrictamente.',
    params: {
      method: 'POST',
      url: '={{ $json.config.embeddingsUrl }}',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'content-type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.embeddings_request) }}',
      options: { timeout: 60000 },
    },
  });
  w.add('Parse Embeddings', 'n8n-nodes-base.code', 2, [col(11), 60], code(embed(
    [{ file: 'kb', exports: ['parseEmbeddings'] }],
    `const { http_response, ...s } = $input.item.json;
const r = parseEmbeddings(http_response, s.chunks.length);
return { json: { ...s, embeddings: r.ok ? { ok: true, mode: 'live', vectors: r.vectors } : { ok: false, mode: 'live', error: r.error } } };`)),
    { notes: 'Falla cerrado: cantidad o dimensión incorrecta = no se guarda nada.' })
   .add('Embeddings OK?', 'n8n-nodes-base.if', 2.2, [col(12), 200], ifBool('={{ $json.embeddings.ok }}'));

  w.add('Embedding Failed', 'n8n-nodes-base.code', 2, [col(13), 560], code(
    `const s = $input.item.json;
return { json: { ...s, http_status: 502, result: { status: 'embedding_failed', doc_id: s.doc.doc_id, error: s.embeddings.error } } };`));

  // ── Upsert idempotente en pgvector ──
  w.add('Prepare Upsert', 'n8n-nodes-base.code', 2, [col(13), 200], code(embed(
    [{ file: 'kb', exports: ['toVectorLiteral'] }],
    `const s = $input.item.json;
const rows = s.chunks.map((c, i) => ({ idx: c.idx, content: c.content, content_hash: c.hash, embedding: toVectorLiteral(s.embeddings.vectors[i]) }));
return { json: { ...s, rows } };`)));
  pgKb(w, 'Upsert Chunks', [col(14), 200],
    `WITH d AS (
  INSERT INTO kb_docs (doc_id, title) VALUES ($1, $2)
  ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now() RETURNING doc_id
), del AS (
  DELETE FROM kb_chunks WHERE doc_id = $1 AND content_hash NOT IN (SELECT content_hash FROM jsonb_to_recordset($3::jsonb) AS x(content_hash text)) RETURNING id
), ins AS (
  INSERT INTO kb_chunks (doc_id, chunk_idx, content, content_hash, embedding)
  SELECT $1, x.idx, x.content, x.content_hash, x.embedding::vector
  FROM jsonb_to_recordset($3::jsonb) AS x(idx int, content text, content_hash text, embedding text), d
  ON CONFLICT (doc_id, content_hash) DO UPDATE SET chunk_idx = EXCLUDED.chunk_idx
  RETURNING (xmax = 0) AS inserted
)
SELECT (SELECT count(*) FROM ins WHERE inserted) AS inserted, (SELECT count(*) FROM ins WHERE NOT inserted) AS unchanged, (SELECT count(*) FROM del) AS removed`,
    '[$json.doc.doc_id, $json.doc.title, JSON.stringify($json.rows)]',
    { notes: 'Idempotente: mismo contenido = misma fila. Los fragmentos que ya no existen en el documento se borran.' });
  w.add('Upserted', 'n8n-nodes-base.code', 2, [col(15), 200], code(
    `const s = $('Prepare Upsert').item.json;
const r = $input.item.json;
const total = Number(r.inserted) + Number(r.unchanged);
if (total !== s.chunks.length) throw new Error('KB upsert for ' + s.doc.doc_id + ' wrote ' + total + ' chunks, expected ' + s.chunks.length);
return { json: { ...s, http_status: 200, result: { status: 'ingested', doc_id: s.doc.doc_id, chunks: s.chunks.length, inserted: Number(r.inserted), unchanged: Number(r.unchanged), removed: Number(r.removed), embeddings: s.embeddings.mode } } };`),
    { notes: 'Verifica que se guardó exactamente lo esperado; si no, falla ruidosamente.' });

  // ── Cierre ──
  w.add('Respond Result', 'n8n-nodes-base.respondToWebhook', 1.4, [col(16), 300],
    { respondWith: 'json', responseBody: '={{ JSON.stringify($json.result) }}', options: { responseCode: '={{ $json.http_status }}' } })
   .add('Assert Ingest', 'n8n-nodes-base.code', 2, [col(16), 480], code(
    `const s = $input.item.json;
if (s.result.status !== 'ingested') throw new Error('KB ingest of ' + s.result.doc_id + ' failed: ' + s.result.status + ': ' + s.result.error);
return { json: s.result };`),
    { notes: 'Falla ruidosamente si los embeddings fallaron: el documento NO queda a medias en la KB.' });

  const L = (from, o) => logBranch(w, from, { workflow: WF, entity: '$json.doc ? $json.doc.doc_id : ""', ...o });
  L('Validate Document', { step: 'request_received', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  L('Chunk Document', { step: 'chunked', detail: '({ chunks: $json.chunks.length, chars: $json.doc.text.length })' });
  L('Upserted', { step: 'ingested', detail: '({ result: $json.result })' });
  L('Embedding Failed', { step: 'embeddings_failed', status: "'failed'", error: '$json.embeddings.error' });

  w.note('## Support · KB Ingest\nOne document → deterministic chunks (hash per chunk) → embeddings (local hashing in mock mode, any provider in live mode) → idempotent upsert into pgvector. Re-ingesting an unchanged document changes nothing; removed paragraphs are deleted.', [col(0) - 20, -250], col(12), 120)
   .note('### Per-step log → Postgres\nNodes "Log · …": side branches.', [col(0) - 20, 760], 480, 90);

  w.link('Ingest Webhook', 'Config').link('Config', 'Validate Document').link('Validate Document', 'Valid Document?')
   .link('Valid Document?', 'Chunk Document', 0).link('Valid Document?', 'Respond 400', 1)
   .link('Chunk Document', 'Any Chunks?').link('Any Chunks?', 'Embed Mode?', 0).link('Any Chunks?', 'Respond 422 (empty)', 1)
   .link('Embed Mode?', 'Build Embeddings Request', 0).link('Embed Mode?', 'Mock Embeddings', 1)
   .link('Build Embeddings Request', 'Embeddings API').link(embExit, 'Parse Embeddings', 1)
   .link('Parse Embeddings', 'Embeddings OK?').link('Mock Embeddings', 'Embeddings OK?')
   .link('Embeddings OK?', 'Prepare Upsert', 0).link('Embeddings OK?', 'Embedding Failed', 1)
   .link('Prepare Upsert', 'Upsert Chunks').link('Upsert Chunks', 'Upserted').link('Upserted', 'Respond Result')
   .link('Embedding Failed', 'Respond Result').link('Respond Result', 'Assert Ingest');

  return { file: 'support-kb-ingest.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
