const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/soppages');

test('página del SOP: título, pasos y citas se escapan; no hay scripts ni formularios', () => {
  const html = P.renderSopPage({ title: 'Refunds <script>alert(1)</script>', sopId: 'r', version: 2, department: 'support', ownerEmail: 'o@x.co', publishedAt: '2027-11-01T10:00:00Z', purpose: 'P "q"',
    steps: [{ kind: 'decision', text: 'If <b>old</b>', actor: '', evidence: 'x<img src=x onerror=1>' }], gaps: [{ type: 'no_owner', step: 1 }], superseded: true, dataLabel: 'TEST DATA' });
  assert.ok(!/<script>alert|<b>old|<img src=x/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Owner: \(not stated\)/);
  assert.match(html, /Superseded/);
  assert.match(html, /Step 1: no owner stated/);
  assert.ok(!/<form|<script/.test(html));
});

test('estados: un borrador y un SOP inexistente dan la misma respuesta', () => {
  assert.equal(P.sopStatus('not_found').status, 404);
  assert.equal(P.sopStatus('invalid_request').status, 400);
  assert.throws(() => P.sopStatus('nope'), /unknown sop status/);
});
