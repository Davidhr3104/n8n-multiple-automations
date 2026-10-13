const { Workflow, CRED, logBranch } = require('../foundation');

// Workflow de errores aparte: Error Trigger → log en Postgres + alerta por email.
module.exports = function errorHandler() {
  const w = Workflow('errhandler000001', 'Global Error Handler');
  w.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {})
   .add('Alert Owner', 'n8n-nodes-base.emailSend', 2.1, [260, -60], {
    resource: 'email',
    operation: 'send',
    fromEmail: 'n8n@localhost',
    toEmail: 'owner@example.com',
    subject: "={{ '[n8n ERROR] ' + $json.workflow.name + ' → ' + ($json.execution.lastNodeExecuted || 'unknown node') }}",
    emailFormat: 'text',
    text: "={{ 'Workflow: ' + $json.workflow.name + '\\nNode: ' + ($json.execution.lastNodeExecuted || 'unknown') + '\\nError: ' + $json.execution.error.message + '\\nExecution: ' + $json.execution.url }}",
    options: { appendAttribution: false },
   }, { credentials: CRED.smtp });
  logBranch(w, 'Error Trigger', {
    workflow: 'error-handler',
    step: 'workflow_error',
    status: "'failed'",
    entity: "$json.workflow.name",
    runId: '$json.execution.id',
    error: "($json.execution.lastNodeExecuted || 'unknown node') + ': ' + $json.execution.error.message",
    detail: '({ workflow: $json.workflow.name, url: $json.execution.url })',
    dy: -130,
  });
  w.link('Error Trigger', 'Alert Owner');
  return { file: 'error-handler.json', workflow: w };
};
