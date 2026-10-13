const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDecision } = require('../lib/retry');

const opts = { maxAttempts: 4, baseSeconds: 2, capSeconds: 60, random: () => 1 }; // random=1 => sin jitter

test('respuesta sin error: no reintenta', () => {
  const d = retryDecision({ content: [] }, 1, opts);
  assert.deepEqual([d.retry, d.failed], [false, false]);
});

test('429 y 5xx se reintentan con backoff exponencial 2,4,8', () => {
  const e = status => ({ error: { message: `${status} - "x"` } });
  assert.equal(retryDecision(e(429), 1, opts).delay_s, 2);
  assert.equal(retryDecision(e(503), 2, opts).delay_s, 4);
  assert.equal(retryDecision(e(500), 3, opts).delay_s, 8);
  assert.equal(retryDecision(e(429), 1, opts).retry, true);
});

test('el delay respeta el tope y aplica jitter entre 50% y 100%', () => {
  const e = { error: { message: '503 - x' } };
  assert.equal(retryDecision(e, 10, { ...opts, maxAttempts: 20 }).delay_s, 60);
  assert.equal(retryDecision(e, 2, { ...opts, random: () => 0 }).delay_s, 2); // 4 * 0.5
});

test('4xx de cliente (401, 400, 404) NO se reintentan y quedan marcados como fallo', () => {
  for (const s of [400, 401, 403, 404, 422]) {
    const d = retryDecision({ error: { message: `${s} - x` } }, 1, opts);
    assert.deepEqual([d.retry, d.failed, d.status], [false, true, s]);
  }
});

test('408 y errores de red sin status se reintentan', () => {
  assert.equal(retryDecision({ error: { message: '408 - timeout' } }, 1, opts).retry, true);
  assert.equal(retryDecision({ error: { message: 'timeout of 60000ms exceeded' } }, 1, opts).retry, true);
  assert.equal(retryDecision({ error: { message: 'getaddrinfo ENOTFOUND api.x.com', code: 'ENOTFOUND' } }, 1, opts).retry, true);
});

test('status desde error.httpCode o error.status tiene prioridad sobre el texto', () => {
  assert.equal(retryDecision({ error: { httpCode: '503', message: 'boom' } }, 1, opts).retry, true);
  assert.equal(retryDecision({ error: { status: 401, message: 'boom' } }, 1, opts).retry, false);
});

test('agotados los intentos: no reintenta, falla y lo declara', () => {
  const d = retryDecision({ error: { message: '503 - x' } }, 4, opts);
  assert.deepEqual([d.retry, d.failed, d.exhausted], [false, true, true]);
  assert.match(d.reason, /exhausted/i);
});

test('respuesta basura (undefined/null) cuenta como error de red reintentable', () => {
  assert.equal(retryDecision(undefined, 1, opts).retry, true);
  assert.equal(retryDecision(null, 1, opts).retry, true);
});
