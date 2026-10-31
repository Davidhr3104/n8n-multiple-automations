// Páginas HTML de la firma del contrato. Todo dato del cliente se escapa. Firmar es un POST: un GET (un escáner de correo,
// una vista previa) solo MUESTRA el contrato, nunca lo firma.
const { esc, page, renderMessagePage } = require('./review');

function renderSignPage({ company, contractText, clientId, token, actionUrl }) {
  return page('Review and sign', `<main class="wrap"><div class="card"><h1>Review and sign</h1><p>${esc(company)}</p>
<pre style="white-space:pre-wrap">${esc(contractText)}</pre>
<form method="post" action="${esc(actionUrl)}"><input type="hidden" name="client_id" value="${esc(clientId)}"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">I agree and sign</button></form></div></main>`);
}

const STATUS = {
  signed: [200, 'Agreement signed', 'Thank you, your agreement is signed. We will be in touch shortly.'],
  already_signed: [200, 'Already signed', 'This agreement was already signed. Nothing else is needed.'],
  invalid_token: [403, 'Link not valid', 'This link is not valid.'],
  expired: [410, 'Link expired', 'This link has expired. Ask your account manager for a new one.'],
  unknown_client: [404, 'Not found', 'We could not find this agreement.'],
  not_awaiting_signature: [409, 'Cannot sign right now', 'This agreement cannot be signed right now.'],
};
function signStatus(kind) {
  if (!STATUS[kind]) throw new Error(`unknown sign status: ${kind}`);
  const [status, title, message] = STATUS[kind];
  return { status, html: renderMessagePage({ title, message }) };
}

module.exports = { renderSignPage, signStatus };
