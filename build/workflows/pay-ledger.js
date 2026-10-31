const { Workflow, embed, CRED, uid, code, ifBool, logBranch, pg, respond } = require('../foundation');
const { PAY } = require('./pay-config');

const WF = 'pay-ledger';
const col = n => n * 240;
const L = exports_ => [{ file: 'schedule', exports: [] }, { file: 'payments', exports: exports_ }];
const RESPOND = { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}', options: { responseCode: '={{ $json.http_status }}' } };

// Alta de factura. El mismo invoice_id con los mismos datos es un duplicado (200); con datos distintos es un conflicto (409) que se ve, nunca se pisa.
const INVOICE_SQL = `WITH d AS (SELECT $1::jsonb AS j),
ex AS (SELECT amount, currency, due_date::text AS due_date, contact_email FROM pay_invoices WHERE invoice_id = (SELECT j->>'invoice_id' FROM d)),
i AS (INSERT INTO pay_invoices (invoice_id, customer_id, customer_name, contact_email, timezone, amount, currency, due_date)
      SELECT j->>'invoice_id', j->>'customer_id', j->>'customer_name', j->>'contact_email', NULLIF(j->>'timezone', ''), (j->>'amount')::numeric, j->>'currency', (j->>'due_date')::date FROM d
      ON CONFLICT (invoice_id) DO NOTHING RETURNING invoice_id),
e AS (INSERT INTO pay_events (invoice_id, event, actor, detail) SELECT invoice_id, 'created', 'system', '{}'::jsonb FROM i RETURNING id)
SELECT (SELECT count(*) FROM i) AS created,
       (SELECT (amount = (SELECT (j->>'amount')::numeric FROM d) AND currency = (SELECT j->>'currency' FROM d) AND due_date = (SELECT j->>'due_date' FROM d) AND contact_email = (SELECT j->>'contact_email' FROM d)) FROM ex) AS same_as_existing`;

// El pago es idempotente por payment_id. paid_total se suma con un UPDATE sobre la fila (se serializa): dos pagos simultáneos no se pierden.
const PAYMENT_SQL = `WITH d AS (SELECT $1::jsonb AS j),
inv AS (SELECT invoice_id, amount, currency FROM pay_invoices WHERE invoice_id = (SELECT j->>'invoice_id' FROM d)),
p AS (INSERT INTO pay_payments (payment_id, invoice_id, amount, currency, paid_at)
      SELECT j->>'payment_id', j->>'invoice_id', (j->>'amount')::numeric, j->>'currency', (j->>'now')::timestamptz FROM d
      WHERE EXISTS (SELECT 1 FROM inv WHERE currency = (SELECT j->>'currency' FROM d)) ON CONFLICT (payment_id) DO NOTHING RETURNING invoice_id, amount),
u AS (UPDATE pay_invoices i SET paid_total = i.paid_total + p.amount,
        status = CASE WHEN i.status IN ('open', 'disputed') AND i.paid_total + p.amount >= i.amount THEN 'paid' ELSE i.status END, updated_at = now(), version = i.version + 1
      FROM p WHERE i.invoice_id = p.invoice_id RETURNING i.invoice_id, i.paid_total, i.amount, i.status, i.currency),
e AS (INSERT INTO pay_events (invoice_id, event, actor, detail) SELECT invoice_id, 'payment', 'system', jsonb_build_object('paid_total', paid_total, 'status', status) FROM u RETURNING id)
SELECT (SELECT count(*) FROM inv) AS invoice_found, (SELECT count(*) FROM inv WHERE currency = (SELECT j->>'currency' FROM d)) AS currency_ok, (SELECT count(*) FROM p) AS recorded,
       (SELECT paid_total FROM u) AS paid_total, (SELECT amount FROM u) AS amount, (SELECT status FROM u) AS status, (SELECT currency FROM u) AS currency`;

module.exports = function payLedger() {
  const w = Workflow('payledger0000001', 'Payments · Invoices & Payments (Auditable)');

  // ── Alta de factura ──
  w.add('Invoice Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 120],
    { httpMethod: 'POST', path: 'pay-invoice', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Factura emitida: {invoice_id, customer_id, customer_name, contact_email, timezone?, amount, currency, due_date}. En live la dispara la contabilidad (Xero / Stripe). Protegido por x-pay-token.' })
   .add('Invoice Config', 'n8n-nodes-base.set', 3.4, [col(1), 120], { mode: 'raw', jsonOutput: JSON.stringify({ config: PAY }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Invoice', 'n8n-nodes-base.code', 2, [col(2), 120], code(embed(L(['normalizeInvoice']),
    `const item = $input.item.json;
const c = item.config;
const n = normalizeInvoice(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-pay-token'] !== c.internalToken) errors.unshift('bad_token');
return { json: { invoice: n.invoice, validation: { ok: errors.length === 0, errors }, config: c } };`)),
    { notes: 'DETERMINÍSTICO: id seguro, correo válido, importe positivo, moneda conocida, fecha real. "now" solo en mock con token.' })
   .add('Valid Invoice?', 'n8n-nodes-base.if', 2.2, [col(3), 120], ifBool('={{ $json.validation.ok }}'))
   .add('Invoice Rejected', 'n8n-nodes-base.code', 2, [col(4), 360], code(
    `const s = $input.item.json;
return { json: { ...s, http_status: 400, body: { status: 'rejected', errors: s.validation.errors } } };`));
  pg(w, 'Insert Invoice', [col(4), 120], INVOICE_SQL, '[JSON.stringify($json.invoice)]', { notes: 'Alta atómica con su evento. Un duplicado exacto no cambia nada; uno con datos distintos se reporta como conflicto.' });
  w.add('Invoice Result', 'n8n-nodes-base.code', 2, [col(5), 120], code(
    `const s = $('Normalize Invoice').item.json;
const r = $input.item.json;
const created = Number(r.created) === 1;
const conflict = !created && r.same_as_existing === false;
const http_status = created ? 201 : conflict ? 409 : 200;
const status = created ? 'created' : conflict ? 'conflict' : 'duplicate';
return { json: { ...s, http_status, body: { status, invoice_id: s.invoice.invoice_id, ...(conflict ? { error: 'invoice_exists_with_different_data' } : {}) }, result: { status, conflict } } };`))
   .add('Respond Invoice', 'n8n-nodes-base.respondToWebhook', 1.4, [col(6), 120], RESPOND)
   .add('Assert Invoice', 'n8n-nodes-base.code', 2, [col(6), 300], code(
    `const s = $input.item.json;
if (s.result.conflict) throw new Error('Invoice ' + s.invoice.invoice_id + ' already exists with different data: the existing invoice was NOT changed');
return { json: s };`),
    { notes: 'Un conflicto falla ruidosamente (→ Error Handler); la factura existente no se toca.' });
  w.add('Respond Invoice 400', 'n8n-nodes-base.respondToWebhook', 1.4, [col(5), 360], RESPOND);

  // ── Pago ──
  w.add('Payment Webhook', 'n8n-nodes-base.webhook', 2, [col(0), 620],
    { httpMethod: 'POST', path: 'pay-payment', responseMode: 'responseNode', options: {} },
    { webhookId: uid(), notes: 'Pago recibido: {payment_id, invoice_id, amount, currency}. En live lo dispara la pasarela (Stripe webhook). Idempotente por payment_id.' })
   .add('Payment Config', 'n8n-nodes-base.set', 3.4, [col(1), 620], { mode: 'raw', jsonOutput: JSON.stringify({ config: PAY }, null, 2), includeOtherFields: true, options: {} })
   .add('Normalize Payment', 'n8n-nodes-base.code', 2, [col(2), 620], code(embed(L(['normalizePayment']),
    `const item = $input.item.json;
const c = item.config;
const n = normalizePayment(item.body, c);
const errors = [...n.errors];
if (!item.headers || item.headers['x-pay-token'] !== c.internalToken) errors.unshift('bad_token');
const p = { ...n.payment, now: n.payment.now || new Date().toISOString() };
return { json: { payment: p, validation: { ok: errors.length === 0, errors }, config: c } };`)))
   .add('Valid Payment?', 'n8n-nodes-base.if', 2.2, [col(3), 620], ifBool('={{ $json.validation.ok }}'))
   .add('Payment Rejected', 'n8n-nodes-base.code', 2, [col(4), 860], code(
    `const s = $input.item.json;
return { json: { ...s, http_status: 400, body: { status: 'rejected', errors: s.validation.errors } } };`));
  pg(w, 'Record Payment', [col(4), 620], PAYMENT_SQL, '[JSON.stringify($json.payment)]', { notes: 'Inserta el pago (idempotente por payment_id) y suma el saldo con un UPDATE atómico. Pagada = sin saldo: la secuencia se detiene.' });
  w.add('Payment Result', 'n8n-nodes-base.code', 2, [col(5), 620], code(embed(L(['applyPayment']),
    `const s = $('Normalize Payment').item.json;
const r = $input.item.json;
const p = s.payment;
let http_status, status;
if (Number(r.invoice_found) === 0) { http_status = 404; status = 'unknown_invoice'; }
else if (Number(r.currency_ok) === 0) { http_status = 409; status = 'currency_mismatch'; }
else if (Number(r.recorded) === 0) { http_status = 200; status = 'duplicate'; }
else { http_status = 201; status = 'recorded'; }
const recorded = status === 'recorded';
const overpaid = recorded ? Math.max(0, Math.round((Number(r.paid_total) - Number(r.amount)) * 100) / 100) : 0;
const balance = recorded ? Math.max(0, Math.round((Number(r.amount) - Number(r.paid_total)) * 100) / 100) : null;
return { json: { ...s, http_status, body: { status, payment_id: p.payment_id, invoice_id: p.invoice_id, ...(recorded ? { invoice_status: r.status, balance, overpaid_by: overpaid } : {}) }, result: { status, recorded, overpaid, currency: r.currency } } };`)),
    { notes: 'DETERMINÍSTICO: factura inexistente = 404, otra moneda = 409 (nada se registra), mismo payment_id = duplicado. Un sobrepago se señala; no se reembolsa solo.' })
   .add('Respond Payment', 'n8n-nodes-base.respondToWebhook', 1.4, [col(6), 620], RESPOND)
   .add('Overpaid?', 'n8n-nodes-base.if', 2.2, [col(6), 820], ifBool('={{ $json.result.overpaid > 0 }}'))
   .add('Build Overpayment Alert', 'n8n-nodes-base.code', 2, [col(7), 780], code(embed(L(['overpaymentAlert']),
    `const s = $input.item.json;
return { json: { ...s, mail: overpaymentAlert({ invoice_id: s.payment.invoice_id, overpaid_by: s.result.overpaid, currency: s.result.currency }) } };`)))
   .add('Send Overpayment Alert', 'n8n-nodes-base.emailSend', 2.1, [col(8), 780], {
    resource: 'email', operation: 'send', fromEmail: '={{ $json.config.fromEmail }}', toEmail: '={{ $json.config.ownerEmail }}', subject: '={{ $json.mail.subject }}',
    emailFormat: 'text', text: '={{ $json.mail.text }}', options: { appendAttribution: false },
  }, { credentials: CRED.smtp, onError: 'continueRegularOutput', notes: 'Aviso a finanzas (Mailpit en local). El pago ya quedó registrado aunque el aviso falle: el fallo queda visible.' })
   .add('Assert Alert', 'n8n-nodes-base.code', 2, [col(9), 780], code(
    `const r = $input.item.json;
if (r.error) throw new Error('Overpayment alert for ' + $('Build Overpayment Alert').item.json.payment.invoice_id + ' was NOT sent: ' + JSON.stringify(r.error));
return { json: r };`));
  w.add('Respond Payment 400', 'n8n-nodes-base.respondToWebhook', 1.4, [col(5), 860], RESPOND);

  const G = (from, o) => logBranch(w, from, { workflow: WF, ...o });
  G('Normalize Invoice', { step: 'invoice_received', entity: '$json.invoice.invoice_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  G('Invoice Result', { step: 'invoice_stored', entity: '$json.invoice.invoice_id', status: "$json.result.conflict ? 'failed' : 'ok'", error: "$json.result.conflict ? 'conflict' : ''", detail: '({ result: $json.result })' });
  G('Normalize Payment', { step: 'payment_received', entity: '$json.payment.invoice_id', status: "$json.validation.ok ? 'ok' : 'failed'", error: "$json.validation.errors.join(',')" });
  G('Payment Result', { step: 'payment_recorded', entity: '$json.payment.invoice_id', status: "$json.result.status === 'recorded' || $json.result.status === 'duplicate' ? 'ok' : 'failed'", error: "$json.result.status === 'recorded' || $json.result.status === 'duplicate' ? '' : $json.result.status", detail: '({ payment_id: $json.payment.payment_id, result: $json.result })' });

  w.note('## Payments · Invoices & Payments\nInvoices arrive from accounting and payments from the payment gateway. Both are idempotent (invoice_id / payment_id). The balance is always amount minus paid_total in SQL: a fully paid invoice stops the reminders, and an overpayment is flagged to a person, never refunded automatically.', [col(0) - 20, -150], col(7), 120);

  w.link('Invoice Webhook', 'Invoice Config').link('Invoice Config', 'Normalize Invoice').link('Normalize Invoice', 'Valid Invoice?')
   .link('Valid Invoice?', 'Insert Invoice', 0).link('Valid Invoice?', 'Invoice Rejected', 1).link('Invoice Rejected', 'Respond Invoice 400')
   .link('Insert Invoice', 'Invoice Result').link('Invoice Result', 'Respond Invoice').link('Invoice Result', 'Assert Invoice')
   .link('Payment Webhook', 'Payment Config').link('Payment Config', 'Normalize Payment').link('Normalize Payment', 'Valid Payment?')
   .link('Valid Payment?', 'Record Payment', 0).link('Valid Payment?', 'Payment Rejected', 1).link('Payment Rejected', 'Respond Payment 400')
   .link('Record Payment', 'Payment Result').link('Payment Result', 'Respond Payment').link('Payment Result', 'Overpaid?')
   .link('Overpaid?', 'Build Overpayment Alert', 0).link('Build Overpayment Alert', 'Send Overpayment Alert').link('Send Overpayment Alert', 'Assert Alert');

  return { file: 'pay-ledger.json', workflow: w, errorWorkflow: 'errhandler000001' };
};
