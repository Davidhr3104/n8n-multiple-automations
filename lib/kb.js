// Base de conocimiento (RAG): troceo, embeddings y validación de lo que devuelve un proveedor.
// Los embeddings locales (mock) son un vector por *hashing* de palabras: determinístico y sin modelo.
// Miden coincidencia de PALABRAS, no significado: sirven para probar el pipeline, no la calidad de un modelo real.

const DIM = 256;
const STOP = new Set(('a an and are as at be but by can do does for from had has have how i if in into is it its me my of on or our so than that the their there these they this to was we were what when where which who will with you your ' +
  'am been being did get got just not now please also any all about would could should').split(/\s+/));

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9áéíóúñü]+/).filter(w => w && !STOP.has(w)).map(stem);
}

// FNV-1a de 32 bits con semilla (para el índice y el signo del hash).
function fnv(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Vector normalizado (norma 1) de DIM dimensiones: palabras (peso 1) + pares de palabras (peso 0.5).
function embedMock(text) {
  const toks = tokenize(text);
  const v = new Array(DIM).fill(0);
  const add = (feature, weight) => { v[fnv(feature, 0) % DIM] += (fnv(feature, 7) & 1 ? 1 : -1) * weight; };
  toks.forEach(t => add(t, 1));
  for (let i = 0; i < toks.length - 1; i++) add(toks[i] + '_' + toks[i + 1], 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

const toVectorLiteral = vec => '[' + vec.map(x => Number(x.toFixed(6))).join(',') + ']';

function contentHash(s) {
  const t = String(s);
  return fnv(t, 0).toString(16).padStart(8, '0') + fnv(t, 31).toString(16).padStart(8, '0') + t.length.toString(16);
}

// Trocea por párrafos hasta ~max caracteres; un párrafo más largo se parte por frases. Cada fragmento es texto completo (sin cortar frases).
function chunkText(text, { max = 600 } = {}) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const pieces = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && (cur + ' ' + s).length > max) { pieces.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
    }
    if (cur) pieces.push(cur);
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur + '\n\n' + p).length > max) { chunks.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((content, idx) => ({ idx, content, hash: contentHash(content) }));
}

// ───────────── Proveedor de embeddings (live) ─────────────
// Contrato supuesto (estilo OpenAI/Voyage): { model, input: [...], dimensions }. SIN verificar contra un proveedor real.
function buildEmbeddingsRequest(texts, cfg) {
  return { model: cfg.embeddingModel, input: texts, dimensions: DIM };
}

function parseEmbeddings(resp, expected) {
  const fail = error => ({ ok: false, error });
  if (!resp || typeof resp !== 'object') return fail('empty or non-object embeddings response');
  if (resp.error) return fail(`embeddings API error: ${resp.error.message || JSON.stringify(resp.error)}`);
  const data = Array.isArray(resp.data) ? resp.data : null;
  if (!data) return fail('embeddings response has no data array');
  if (data.length !== expected) return fail(`expected ${expected} embeddings, got ${data.length}`);
  const vectors = [];
  for (const d of data) {
    const e = d && d.embedding;
    if (!Array.isArray(e) || e.length !== DIM) return fail(`embedding must have ${DIM} dimensions, got ${Array.isArray(e) ? e.length : typeof e}`);
    if (!e.every(x => typeof x === 'number' && Number.isFinite(x))) return fail('embedding contains non-numeric values');
    vectors.push(e);
  }
  return { ok: true, vectors };
}

module.exports = { DIM, tokenize, embedMock, toVectorLiteral, contentHash, chunkText, buildEmbeddingsRequest, parseEmbeddings };
