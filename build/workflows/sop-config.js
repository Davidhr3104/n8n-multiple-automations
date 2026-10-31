// Config de SOP Generator (se incrusta en el nodo Config de cada workflow).
const mode = process.env.SOP_MODE || 'mock';
module.exports = {
  SOP: {
    mode,                                                         // 'mock' = wiki simulada en Postgres | 'live' = sin override de tiempo
    aiMode: process.env.AI_MODE || 'mock',                        // extracción de pasos: 'mock' = frases clave | 'live' = Claude
    model: 'claude-sonnet-5-5',
    allowTimeOverride: mode === 'mock',                           // "now" en el payload SOLO en mock y con token
    departments: ['ops', 'support', 'finance', 'sales', 'hr'],
    minSteps: 3, maxSteps: 40, maxSourceChars: 20000,
    minGroundedRatio: 0.7,                                        // por debajo, demasiados pasos no estaban en el texto: no se manda a aprobar
    approvalTimeoutHours: 48,
    reviewAfterDays: 90, escalateAfterDays: 14, pendingReminderDays: 1,
    opsEmail: 'operations@example.com',
    fromEmail: 'sop@demo.example',
    baseUrl: 'http://localhost:5678/webhook',                     // enlaces a la página del SOP. En producción: el dominio público
    internalToken: 'local-dev-token',                             // cabecera x-sop-token (draft / run)
    dataLabel: 'TEST DATA · synthetic procedures',
  },
};
