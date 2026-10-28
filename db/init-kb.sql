-- Base de conocimiento del Support Reply Agent (contenedor pgvector, base "knowledge"). Idempotente.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_docs (
  doc_id      text PRIMARY KEY,
  title       text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- embedding de 256 dimensiones (el proveedor live debe devolver 256). La búsqueda usa distancia coseno.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id           bigserial PRIMARY KEY,
  doc_id       text        NOT NULL REFERENCES kb_docs (doc_id) ON DELETE CASCADE,
  chunk_idx    integer     NOT NULL,
  content      text        NOT NULL,
  content_hash text        NOT NULL,
  embedding    vector(256) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, content_hash)
);
CREATE INDEX IF NOT EXISTS kb_chunks_doc_idx ON kb_chunks (doc_id, chunk_idx);
-- Con una KB pequeña la búsqueda exacta es suficiente y más precisa; con miles de fragmentos se añadiría un índice HNSW:
--   CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
