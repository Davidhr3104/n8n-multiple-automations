// Genera workflows/*.json y credentials/*.json a partir de lib/*.js y build/workflows/*.js
// Uso: npm run build
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./foundation');

const SETTINGS = { executionOrder: 'v1', timezone: 'America/Bogota', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true, saveExecutionProgress: true };
const ERROR_WORKFLOW_ID = 'errhandler000001';

const builders = [
  require('./workflows/error-handler'),
  require('./workflows/lead-intake'),
  require('./workflows/weekly-report'),
  require('./workflows/revival-run'),
  require('./workflows/revival-touch'),
  require('./workflows/revival-reply'),
  require('./workflows/revival-prepare'),
  require('./workflows/revival-review'),
  require('./workflows/revival-queue'),
  require('./workflows/revival-dashboard'),
  require('./workflows/qualifier-send'),
  require('./workflows/qualifier-inbound'),
  require('./workflows/qualifier-booking'),
  require('./workflows/qualifier-stale'),
  require('./workflows/support-kb-ingest'),
  require('./workflows/support-ticket'),
  require('./workflows/sync-run'),
  require('./workflows/sync-review'),
  require('./workflows/sync-weekly'),
  require('./workflows/invoice-intake'),
  require('./workflows/triage-intake'),
  require('./workflows/triage-sla-watch'),
  require('./workflows/triage-update'),
  require('./workflows/reminders-send'),
  require('./workflows/reminders-reply'),
  require('./workflows/reminders-noshow'),
  require('./workflows/reminders-staff'),
  require('./workflows/onboarding-start'),
  require('./workflows/onboarding-signed'),
  require('./workflows/onboarding-sequence'),
  require('./workflows/sop-draft'),
  require('./workflows/sop-view'),
  require('./workflows/sop-sweep'),
  require('./workflows/pay-ledger'),
  require('./workflows/pay-dunning'),
  require('./workflows/pay-reply'),
];

fs.mkdirSync(path.join(ROOT, 'workflows'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'credentials'), { recursive: true });

const built = [];
for (const make of builders) {
  const { file, workflow, errorWorkflow } = make();
  const json = workflow.build(errorWorkflow ? { ...SETTINGS, errorWorkflow: ERROR_WORKFLOW_ID } : SETTINGS);
  fs.writeFileSync(path.join(ROOT, 'workflows', file), JSON.stringify(json, null, 2));
  built.push(`${file} (${json.nodes.length} nodes)`);
}

// Infra local: sin secretos reales, se reimporta en cada deploy (idempotente por id).
const infra = [
  { id: 'smtpMailpit01', name: 'Mailpit (local SMTP)', type: 'smtp', data: { host: 'mailpit', port: 1025, secure: false, disableStartTls: true, user: '', password: '' } },
  { id: 'postgresKb01', name: 'pgvector local (knowledge base)', type: 'postgres', data: { host: 'pgvector', port: 5432, database: 'knowledge', user: 'knowledge', password: 'knowledge_local', maxConnections: 10, allowUnauthorizedCerts: false, ssl: 'disable' } },
  { id: 'postgresLocal01', name: 'Postgres local (automations)', type: 'postgres', data: { host: 'postgres', port: 5432, database: 'automations', user: 'automations', password: 'automations_local', maxConnections: 20, allowUnauthorizedCerts: false, ssl: 'disable' } },
];
// PLACEHOLDERS: solo se importan con deploy.ps1 -WithCredentials (la primera vez). Luego pones tus keys reales en la UI de n8n.
const placeholders = [
  { id: 'anthropicKey01', name: 'Anthropic API (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'x-api-key', value: 'TU_ANTHROPIC_API_KEY' } },
  { id: 'ghlKey01', name: 'GoHighLevel (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer TU_GHL_PRIVATE_INTEGRATION_TOKEN' } },
];
// Placeholders del Support Reply Agent (Gmail y proveedor de embeddings). Archivo aparte: así se pueden importar sin pisar las keys ya puestas.
const supportPlaceholders = [
  { id: 'gmailKey01', name: 'Gmail API (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer TU_GMAIL_ACCESS_TOKEN' } },
  { id: 'embeddingsKey01', name: 'Embeddings API (PLACEHOLDER)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer TU_EMBEDDINGS_API_KEY' } },
];
fs.writeFileSync(path.join(ROOT, 'credentials', 'credentials-placeholders-support.json'), JSON.stringify(supportPlaceholders, null, 2));
fs.writeFileSync(path.join(ROOT, 'credentials', 'credentials-infra.json'), JSON.stringify(infra, null, 2));
fs.writeFileSync(path.join(ROOT, 'credentials', 'credentials-placeholders.json'), JSON.stringify(placeholders, null, 2));
const legacy = path.join(ROOT, 'credentials', 'credentials.json');
if (fs.existsSync(legacy)) fs.unlinkSync(legacy);

console.log(`built: ${built.join(', ')}; credentials-infra.json, credentials-placeholders.json`);
