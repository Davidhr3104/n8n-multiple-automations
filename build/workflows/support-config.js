// Config compartida por los workflows del Support Reply Agent (se incrusta en el nodo Config de cada uno).
module.exports = {
  SUPPORT: {
    aiMode: process.env.AI_MODE || 'mock',            // 'mock' = clasificación, redacción y embeddings locales | 'live' = Claude + proveedor de embeddings
    gmailMode: process.env.GMAIL_MODE || 'mock',      // 'mock' = respuesta por email local (Mailpit) | 'live' = Gmail API (threadId)
    model: 'claude-sonnet-5-5',
    embeddingModel: 'TU_MODELO_DE_EMBEDDINGS',        // el proveedor debe devolver 256 dimensiones
    embeddingsUrl: process.env.EMBEDDINGS_URL || 'https://api.example.com/v1/embeddings',   // contrato SIN verificar
    storeName: 'Demo Store',
    topK: 4,
    minSimilarity: Number(process.env.SUPPORT_MIN_SIMILARITY) || 0.3,   // por debajo, la respuesta pasa por una persona
    minConfidence: 0.75,
    approvalTimeoutHours: 24,
    internalToken: 'local-dev-token',                 // cabecera x-support-token. En producción: Header Auth real + secreto
    supportOwnerEmail: 'support-lead@example.com',
    fromEmail: 'support@demo-store.example',
    dataLabel: 'TEST DATA · synthetic KB and tickets',
  },
};
