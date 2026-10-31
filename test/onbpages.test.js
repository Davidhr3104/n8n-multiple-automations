const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/onbpages');

test('página de firma: el contrato y la empresa se escapan; firmar es un POST con el token oculto, nunca un enlace que firme', () => {
  const html = P.renderSignPage({ company: 'Acme <b>Corp</b>', contractText: 'Fee: 10\n<script>alert(1)</script>', clientId: 'c1', token: 'tok"1', actionUrl: 'http://x/submit' });
  assert.ok(!/<script>alert|<b>Corp/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<form method="post" action="http:\/\/x\/submit">/);
  assert.match(html, /name="token" value="tok&quot;1"/);
  assert.match(html, /I agree and sign/);
  assert.ok(!/<a [^>]*href="[^"]*token/.test(html)); // ningún enlace lleva el token para firmar con un GET
});

test('páginas de estado: un mensaje claro por caso, sin filtrar datos', () => {
  for (const k of ['signed', 'already_signed', 'invalid_token', 'expired', 'unknown_client', 'not_awaiting_signature']) {
    const { status, html } = P.signStatus(k);
    assert.ok(status >= 200 && status < 500);
    assert.match(html, /<h1>/);
  }
  assert.equal(P.signStatus('invalid_token').status, 403);
  assert.equal(P.signStatus('expired').status, 410);
  assert.equal(P.signStatus('unknown_client').status, 404);
  assert.equal(P.signStatus('signed').status, 200);
  assert.throws(() => P.signStatus('nope'), /unknown sign status/);
});
