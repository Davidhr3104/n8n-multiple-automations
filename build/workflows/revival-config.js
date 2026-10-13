// Config compartida por los 3 workflows del revival (se incrusta en el nodo Config de cada uno: mantenla aquí para que no diverjan).
module.exports = {
  REVIVAL: {
    aiMode: process.env.AI_MODE || 'mock',     // 'mock' = sin API key | 'live' = Claude API
    crmMode: process.env.CRM_MODE || 'mock',   // 'mock' = envío simulado por email local + custom fields locales | 'live' = GoHighLevel
    model: 'claude-sonnet-5-5',
    inactivityDays: 90,        // un contacto sin actividad por más de N días es candidato
    maxPerRun: Number(process.env.REVIVAL_MAX) || 10,   // tope de contactos por corrida (nuevos + follow-ups)
    maxTouches: 3,             // toques máximos por contacto
    gapDays: [3, 5],           // espera tras el toque 1 y tras el toque 2
    defaultCountryCode: '57',  // para normalizar teléfonos sin prefijo al cruzar con la lista de bajas
    bookingUrl: 'https://cal.example.com/book/demo',
    senderName: 'Equipo Demo',
    ownerEmail: 'owner@example.com',
    fromEmail: 'n8n@localhost',
    approvalTimeoutHours: 24,
    replyConfidenceThreshold: 0.6,
    internalToken: 'local-dev-token',  // cabecera x-revival-token entre workflows. En producción: Header Auth real + secreto
    touchUrl: 'http://localhost:5678/webhook/revival-touch',
    ghlLocationId: 'TU_GHL_LOCATION_ID',
  },
};
