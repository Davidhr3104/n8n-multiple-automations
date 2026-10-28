const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../lib/kb');

const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('embedMock: 256 dimensions, unit norm, deterministic, zero vector for empty text', () => {
  const v = kb.embedMock('How long does standard shipping take?');
  assert.equal(v.length, 256);
  assert.ok(Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) < 1e-9);
  assert.deepEqual(v, kb.embedMock('How long does standard shipping take?'));
  assert.ok(kb.embedMock('the of and').every(x => x === 0));
});

test('embedMock: a related text is closer than an unrelated one', () => {
  const q = kb.embedMock('how long does shipping take to arrive');
  const rel = kb.embedMock('Standard shipping takes 3 to 5 business days to arrive.');
  const unrel = kb.embedMock('Passwords can be reset from the account settings page.');
  assert.ok(cosine(q, rel) > cosine(q, unrel) + 0.1, `${cosine(q, rel)} vs ${cosine(q, unrel)}`);
});

test('tokenize: drops stopwords, stems plurals and -ing/-ed', () => {
  assert.deepEqual(kb.tokenize('The returns are shipping and shipped'), ['return', 'shipp', 'shipp']);
  assert.deepEqual(kb.tokenize(''), []);
});

test('chunkText: keeps paragraphs whole, respects max, stable hashes, no empty chunks', () => {
  const text = 'First paragraph about shipping.\n\nSecond paragraph about returns.\n\n\n\nThird.';
  const small = kb.chunkText(text, { max: 35 });
  assert.ok(small.length >= 3);
  assert.ok(small.every(c => c.content.length > 0 && c.content.length <= 80));
  assert.deepEqual(small.map(c => c.idx), small.map((_, i) => i));
  const one = kb.chunkText(text, { max: 600 });
  assert.equal(one.length, 1);
  assert.equal(kb.chunkText(text, { max: 600 })[0].hash, one[0].hash);
  assert.notEqual(kb.contentHash('a'), kb.contentHash('b'));
  assert.deepEqual(kb.chunkText('   \n\n  '), []);
});

test('chunkText: a long paragraph is split by sentences, never mid-sentence', () => {
  const sentence = 'This is a sentence about our policy.';
  const long = Array(30).fill(sentence).join(' ');
  const chunks = kb.chunkText(long, { max: 200 });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(c => c.content.endsWith('.')));
  assert.equal(chunks.map(c => c.content).join(' ').replace(/\s+/g, ' '), long);
});

test('toVectorLiteral: pgvector text format', () => {
  assert.equal(kb.toVectorLiteral([0.5, -0.25, 0]), '[0.5,-0.25,0]');
  assert.match(kb.toVectorLiteral(kb.embedMock('hello world')), /^\[.*\]$/);
});

test('parseEmbeddings: validates count, dimensions and values', () => {
  const ok = n => ({ data: Array.from({ length: n }, () => ({ embedding: new Array(256).fill(0.1) })) });
  assert.equal(kb.parseEmbeddings(ok(2), 2).ok, true);
  assert.match(kb.parseEmbeddings(ok(1), 2).error, /expected 2/);
  assert.match(kb.parseEmbeddings({ data: [{ embedding: [1, 2, 3] }] }, 1).error, /256 dimensions/);
  assert.match(kb.parseEmbeddings({ data: [{ embedding: new Array(256).fill('x') }] }, 1).error, /non-numeric/);
  assert.match(kb.parseEmbeddings({ error: { message: 'rate limit' } }, 1).error, /rate limit/);
  assert.equal(kb.parseEmbeddings(null, 1).ok, false);
  assert.equal(kb.parseEmbeddings({}, 1).ok, false);
});
