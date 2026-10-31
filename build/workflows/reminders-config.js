// Config de Appointment Reminders + No-show (se incrusta en el nodo Config de cada workflow).
const mode = process.env.REMINDERS_MODE || 'mock';
module.exports = {
  REM: {
    mode,                                                        // 'mock' = SMS como correo a Mailpit | 'live' = sin override de tiempo
    aiMode: process.env.AI_MODE || 'mock',                       // clasificación de texto libre: 'mock' = palabras clave | 'live' = Claude
    model: 'claude-sonnet-5-5',
    allowTimeOverride: mode === 'mock',                          // "now" y "received_at" en el payload SOLO en mock y con token
    minConfidence: 0.85,                                         // por debajo, una persona decide
    maxAttempts: 2,                                              // respuestas inválidas seguidas antes de pasar a una persona
    defaultTimezone: 'America/Bogota',
    sendWindow: { weekdays: [1, 2, 3, 4, 5, 6, 7], startHour: 8, endHour: 20 },   // un recordatorio no sale de madrugada
    reminders: [                                                 // r48: entre 48 h y 24 h antes | r2: entre 2 h y 30 min antes
      { kind: 'r48', beforeMin: 2880, minLeadMin: 1440 },
      { kind: 'r2', beforeMin: 120, minLeadMin: 30 },
    ],
    runIntervalMin: 10,
    graceMin: 15,                                                // minutos de gracia antes de marcar no-show
    lookbackHours: 48,                                           // hasta cuándo se atiende un no-show
    slotMinLeadMin: 240,                                         // no se ofrecen horarios con menos de 4 h de margen
    slotHorizonDays: 7,
    maxOffered: 3,
    repeatNoShowThreshold: 2,                                    // no-shows en 90 días que activan el aviso a una persona (nunca bloqueo automático)
    ownerEmail: 'frontdesk@example.com',
    fromEmail: 'reminders@demo.example',
    internalToken: 'local-dev-token',                            // cabecera x-reminders-token. En producción: Header Auth real + secreto
    dataLabel: 'TEST DATA · synthetic appointments',
  },
};
