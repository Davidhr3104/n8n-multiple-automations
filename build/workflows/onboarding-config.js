// Config de Client Onboarding (se incrusta en el nodo Config de cada workflow).
const mode = process.env.ONBOARDING_MODE || 'mock';
module.exports = {
  ONB: {
    mode,                                                         // 'mock' = herramientas simuladas en Postgres | 'live' = sin override de tiempo
    aiMode: process.env.AI_MODE || 'mock',                        // resumen de las notas: 'mock' = frases clave | 'live' = Claude
    model: 'claude-sonnet-5-5',
    allowTimeOverride: mode === 'mock',                           // "now" en el payload SOLO en mock y con token
    defaultTimezone: 'America/Bogota',
    autoSendLimit: 5000,                                          // por encima, el responsable aprueba antes de enviar el contrato
    approvalTimeoutHours: 48,
    holidays: ['2027-12-08', '2027-12-25', '2028-01-01'],
    sendWindow: { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 18 },
    contractExpiryDays: 14, nudgeAfterDays: 3, escalateAfterDays: 7,
    taskDueIntakeDays: 5,                                         // días laborables para las tareas que salen de las notas del cliente
    freemail: ['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com'],
    packages: {
      starter: { label: 'Starter', tasks: [
        { title: 'Set up project workspace', offsetDays: 1, owner: 'ops' }, { title: 'Kickoff call', offsetDays: 2, owner: 'account_manager' }, { title: 'Collect brand assets', offsetDays: 3, owner: 'client' }] },
      growth: { label: 'Growth', tasks: [
        { title: 'Set up project workspace', offsetDays: 1, owner: 'ops' }, { title: 'Kickoff call', offsetDays: 2, owner: 'account_manager' }, { title: 'Collect brand assets', offsetDays: 3, owner: 'client' },
        { title: 'Analytics access', offsetDays: 3, owner: 'client' }, { title: 'Strategy workshop', offsetDays: 5, owner: 'account_manager' }] },
      enterprise: { label: 'Enterprise', requiresReview: true, tasks: [
        { title: 'Set up project workspace', offsetDays: 1, owner: 'ops' }, { title: 'Dedicated channel setup', offsetDays: 2, owner: 'ops' }, { title: 'Executive kickoff', offsetDays: 3, owner: 'account_manager' },
        { title: 'Security questionnaire', offsetDays: 5, owner: 'client' }] },
    },
    ownerEmail: 'accounts@example.com',
    fromEmail: 'onboarding@demo.example',
    baseUrl: 'http://localhost:5678/webhook',                     // enlaces de firma. En producción: el dominio público
    internalToken: 'local-dev-token',                             // cabecera x-onboarding-token (start / run). La firma usa el token de un solo uso
    dataLabel: 'TEST DATA · synthetic clients',
  },
};
