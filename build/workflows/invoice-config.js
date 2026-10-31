// Config del Invoice & Document Processor (se incrusta en el nodo Config).
module.exports = {
  INVOICE: {
    aiMode: process.env.AI_MODE || 'mock',                   // 'mock' = lector local de texto etiquetado | 'live' = Claude (visión/PDF)
    accountingMode: process.env.ACCOUNTING_MODE || 'mock',   // 'mock' = tabla invoice_ledger | 'live' = Xero/Sheets: NO construido, falla ruidosamente
    model: 'claude-sonnet-5-5',
    autoApproveLimit: 2000,                                  // por encima, SIEMPRE una persona
    minConfidence: 0.85,                                     // confianza mínima de los campos críticos
    maxPlausibleTotal: 1000000,
    futureDays: 7,
    staleDays: 365,
    approvalTimeoutHours: 48,
    internalToken: 'local-dev-token',                        // cabecera x-invoice-token. En producción: Header Auth real + secreto
    ownerEmail: 'ap-lead@example.com',
    fromEmail: 'invoices@demo.example',
    dataLabel: 'TEST DATA · synthetic invoices',
  },
};
