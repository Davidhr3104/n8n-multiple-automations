// Config compartida por los workflows del Conversational Qualifier (se incrusta en el nodo Config de cada uno).
const { REVIVAL } = require('./revival-config');

module.exports = {
  QUALIFIER: {
    aiMode: process.env.AI_MODE || 'mock',     // 'mock' = sin API key | 'live' = Claude API
    crmMode: process.env.CRM_MODE || 'mock',   // 'mock' = SMS simulado por email local + calendario en Postgres | 'live' = GoHighLevel
    model: 'claude-sonnet-5-5',
    businessName: 'Demo Agency',
    // Criterios de calificación (edítalos por cliente). required: sin responderlos no se califica.
    criteria: [
      { key: 'need', question: 'What process would you like to automate?', required: true },
      { key: 'timeline', question: 'When would you like to get started?', required: true },
      { key: 'team_size', question: 'How many people are on your team?', required: false },
    ],
    confidenceThreshold: 0.6,
    maxAttempts: 6,            // turnos del lead sin calificar antes de pasar a un humano
    maxBookingAttempts: 2,     // reofertas de horario (elección poco clara o horario ocupado) antes de pasar a un humano
    followUpHours: 24,
    staleHours: 72,
    defaultCountryCode: '57',
    defaultTimezone: REVIVAL.defaultTimezone,
    sendWindow: REVIVAL.sendWindow,            // mismo horario 9-19 h L-V, hora local del lead
    internalToken: 'local-dev-token',          // cabecera x-qualifier-token (entrada y entre workflows). En producción: Header Auth real + secreto
    sendUrl: 'http://localhost:5678/webhook/qualifier-send',
    bookingUrl: 'http://localhost:5678/webhook/qualifier-booking',
    handoffEmail: 'owner@example.com',
    fromEmail: 'n8n@localhost',
    salesReps: [
      { name: 'Rep Uno', email: 'rep1@example.com' },
      { name: 'Rep Dos', email: 'rep2@example.com' },
    ],
    ghlLocationId: 'TU_GHL_LOCATION_ID',
    ghlCalendarId: 'TU_GHL_CALENDAR_ID',
    dataLabel: 'TEST DATA · synthetic contacts',
  },
};
