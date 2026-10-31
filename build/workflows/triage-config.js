// Config del Ticket Triage + SLA Watcher (se incrusta en el nodo Config).
const mode = process.env.TRIAGE_MODE || 'mock';
module.exports = {
  TRIAGE: {
    mode,                                                     // 'mock' = pruebas locales | 'live' = sin override de tiempo
    aiMode: process.env.AI_MODE || 'mock',                    // 'mock' = clasificador local por palabras clave | 'live' = Claude
    model: 'claude-sonnet-5-5',
    allowTimeOverride: mode === 'mock',                       // received_at / now en el payload SOLO en mock y con token (permite probar el SLA sin esperar horas)
    minConfidence: 0.85,                                      // por debajo, una persona confirma
    warnAt: 0.75,                                             // aviso cuando se ha consumido el 75 % del plazo
    leadEmail: 'support-lead@example.com',
    fromEmail: 'triage@demo.example',
    internalToken: 'local-dev-token',                         // cabecera x-triage-token. En producción: Header Auth real + secreto
    planFloor: { enterprise: 'P2', pro: 'P3', free: 'P4' },   // piso de prioridad por plan del cliente (la IA no puede bajarlo)
    // Horario laboral con zona fija (sin DST): lunes a viernes, 09:00-18:00 hora de Bogotá (UTC-5).
    bh: { offsetMinutes: -300, startHour: 9, endHour: 18, workdays: [1, 2, 3, 4, 5], holidays: ['2026-12-25', '2027-01-01'] },
    // Minutos de plazo por prioridad. P1 corre en horas corridas; el resto solo en horario laboral.
    sla: {
      P1: { first: 60, resolve: 240, calendar: true },
      P2: { first: 240, resolve: 1080, calendar: false },
      P3: { first: 480, resolve: 2700, calendar: false },
      P4: { first: 1080, resolve: 5400, calendar: false },
    },
    dataLabel: 'TEST DATA · synthetic tickets',
  },
};
