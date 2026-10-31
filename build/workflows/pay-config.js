// Config de Payment Reminders (se incrusta en el nodo Config de cada workflow).
const mode = process.env.PAYMENTS_MODE || 'mock';
module.exports = {
  PAY: {
    mode,                                                         // 'mock' = contabilidad simulada en Postgres | 'live' = sin override de tiempo
    aiMode: process.env.AI_MODE || 'mock',                        // clasificación de la respuesta: 'mock' = palabras clave | 'live' = Claude
    model: 'claude-sonnet-5-5',
    allowTimeOverride: mode === 'mock',                           // "now" en el payload SOLO en mock y con token
    defaultTimezone: 'America/Bogota',
    sendWindow: { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 18 },
    // Tono creciente pero siempre cortés. La etapa final no escribe al cliente: avisa a una persona.
    stages: [
      { stage: 'upcoming', offsetDays: -3 }, { stage: 'due', offsetDays: 0 }, { stage: 'overdue1', offsetDays: 7 },
      { stage: 'overdue2', offsetDays: 14 }, { stage: 'final', offsetDays: 30, escalate: true },
    ],
    currencyList: ['USD', 'COP', 'EUR', 'MXN'],
    minConfidence: 0.8, maxPromiseDays: 14, claimPauseDays: 3,
    payLinkBase: 'https://pay.example.com/invoice',               // enlace de pago. En live: el de la pasarela
    ownerEmail: 'finance@example.com',
    fromEmail: 'billing@demo.example',
    internalToken: 'local-dev-token',                             // cabecera x-pay-token
    dataLabel: 'TEST DATA · synthetic invoices',
  },
};
