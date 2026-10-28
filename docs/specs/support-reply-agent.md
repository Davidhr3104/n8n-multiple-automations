# Support Reply Agent (RAG) — plan

Objetivo: responder tickets de soporte por email con una respuesta **fundamentada en una base de conocimiento (KB) y con cita de fuente**.
Lo que la KB no cubre, lo sensible o lo que pide una acción se escala a una persona. Nada sale sin pasar por reglas determinísticas.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Vector store | Contenedor aparte `pgvector` (`pgvector/pgvector:pg16`), base `knowledge` | El Postgres actual es Alpine (musl): cambiarle la imagen sobre el mismo volumen puede alterar el orden de los índices de texto. Un contenedor aparte no toca datos existentes |
| Embeddings en local (`aiMode=mock`) | Vector de 256 dimensiones por *hashing* de palabras (sin pesos de modelo) | Determinístico y gratis. **Mide léxico, no semántica**: el % de aciertos en local valida el pipeline y las compuertas, NO la calidad de un modelo real |
| Embeddings en live | Proveedor enchufable (HTTP) que devuelva 256 dimensiones | Contrato SIN verificar; la respuesta se valida estrictamente (cantidad y dimensión) |
| Entrada | Webhook `POST /webhook/support-ticket` | En live, el disparador es el Gmail Trigger (mismo payload normalizado) |
| Respuesta en el hilo | Local: email a Mailpit con `In-Reply-To`/`References`. Live: Gmail API con `threadId` + MIME construido por código | Contrato de Gmail SIN verificar |
| Aprobación humana | Email `sendAndWait` (mismo patrón que Lead Intake) | Slack = cambiar ese nodo |

## Flujo

1. **Validar + idempotencia** por `ticket_id` (respuesta 202 inmediata, duplicado 200).
2. **Reglas duras (código)**: tema sensible (legal, contracargo/chargeback, fraude, seguridad, salud) → humano, sin borrador. Intento de inyección → se marca.
3. **Clasificar (IA juzga)**: ¿es soporte?, intención, sentimiento, ¿pide una acción sobre una cuenta/pedido? (cancelar, reembolsar, cambiar dirección, estado de un pedido concreto).
   Acción o cliente enojado → humano, sin borrador (el agente solo tiene la KB, no el sistema de pedidos).
4. **Recuperar**: top-4 fragmentos de la KB por similitud coseno (pgvector).
5. **Redactar (IA)** SOLO con esos fragmentos, citando ids.
6. **Validar el borrador (código)**: citas existentes entre los recuperados; cada cifra, fecha, URL o email de la respuesta debe estar en el texto citado (anti-alucinación verificable).
7. **Compuerta (código)**: respuesta automática solo si similitud ≥ umbral, confianza ≥ umbral, borrador fundamentado y sin banderas. Si no: aprobación de una persona con el borrador y las fuentes. Sin borrador: aviso de escalamiento.
8. **Enviar en el mismo hilo**, guardar ticket + fragmentos usados + decisión, log por paso, errores visibles.

## KB Ingest (workflow aparte)
`POST /webhook/support-kb-ingest {doc_id, title, text}` → trocea por párrafos (≈600 caracteres con solape) → embeddings → upsert idempotente por hash de contenido; los fragmentos que ya no existen se borran.

## Evaluación (el número que importa)
`scripts/eval-support.ps1`: 30 preguntas sobre una KB sintética ("Demo Store") con la salida esperada de cada una:
- **18 respondibles** → debe responder automáticamente y citar el documento correcto,
- **6 fuera de la KB** → debe escalar (nunca inventar),
- **3 sensibles/acciones** → debe ir a un humano sin borrador,
- **2 inyecciones** y **1 cliente enojado** → no obedecer / escalar.

Métricas: acierto de respuesta+cita, escalamientos correctos, **respuestas automáticas incorrectas** (la que más duele) y tasa de automatización.
Se ejecuta de verdad contra el workflow. Con embeddings simulados el resultado describe el pipeline, no un modelo real.

## Fuera de alcance
Consulta real de pedidos (requiere integración con el sistema de pedidos), multi-idioma en local, hilos con adjuntos.
