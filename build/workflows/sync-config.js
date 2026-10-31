// Config compartida por los workflows de CRM ↔ Sheets Sync (se incrusta en el nodo Config de cada uno).
module.exports = {
  SYNC: {
    mode: process.env.SYNC_MODE || 'mock',            // 'mock' = tablas de Postgres hacen de CRM y hoja | 'live' = NO construido: falla ruidosamente
    defaultCountry: '57',                             // código de país para teléfonos sin prefijo (igual que norm_phone() en SQL)
    nameThreshold: 0.5,                               // similitud de nombres mínima para tratar "mismo teléfono" como duplicado
    lockSeconds: 300,                                 // una sola corrida a la vez; si una muere, el bloqueo vence solo
    internalToken: 'local-dev-token',                 // cabecera x-sync-token. En producción: Header Auth real + secreto
    reviewUrl: 'http://localhost:5678/webhook/sync-review',
    reviewSubmitUrl: '/webhook/sync-review-submit',
    ownerEmail: 'ops-lead@example.com',
    fromEmail: 'sync@demo.example',
    dataLabel: 'TEST DATA · synthetic contacts (mock CRM and sheet)',
  },
};
