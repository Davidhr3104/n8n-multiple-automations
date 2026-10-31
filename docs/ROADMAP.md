# Roadmap — 5 automatizaciones sobre una fundación común

Decisiones (2026-10-13): orden **Fundación → #5 → #1 → #4 → #2 → #3** · log/idempotencia en **Postgres local**
(esquema compatible con Supabase) · aprobación humana por **email (Mailpit)** con Slack enchufable después.

## Fundación (HECHA, verificada en local)

| Pieza | Cómo está resuelta | Verificado |
|---|---|---|
| Error Trigger + workflow de errores aparte | `Global Error Handler`: log en Postgres + email | Sí: fallo real de CRM → fila `workflow_error` + email |
| Reintentos con backoff | `lib/retry.js` + bucle Check → Wait → reintento (`httpWithBackoff`). 429/5xx/red se reintentan; 4xx de cliente no | Sí: 4 intentos con esperas 1 / 2 / 6.2 s; 401 = 1 intento |
| Log de cada ejecución (id, paso, estado, error) | Tabla `execution_log` + nodos `Log · <paso>` (`logBranch`) | Sí: orden cronológico, incluso a través de la espera humana |
| Idempotencia | Tabla `idempotency_keys`, reclamo atómico por PRIMARY KEY; reprocesa si el intento previo quedó `failed` o `processing` > 1 h | Sí: duplicado → 200; fallo → reenvío reprocesa (`attempts: 2`) |
| Aprobación humana antes de acciones externas | Email `sendAndWait` (Mailpit); Slack = cambiar ese nodo | Email sí; Slack NO |

Notas de diseño:
- La reutilización es a nivel de **generador** (`build/foundation.js`), no sub-workflows de n8n: cada workflow queda autocontenido y legible en el canvas.
- n8n (executionOrder v1) ejecuta las ramas de una salida **de arriba a abajo por posición**. `tidy()` coloca cada nodo de log encima de sus hermanos para que corra primero. Si se mueven a mano en el canvas, el orden del log puede alterarse.
- El bucle de backoff usa `$runIndex`: asume **1 ítem por ejecución** (webhook). Para lotes hay que procesar por sub-workflow.

## Automatizaciones

| # | Automatización | Estado | Qué falta |
|---|---|---|---|
| 5 | Calificación de leads + reporte semanal | **HECHA en local (modo mock/live)** — ver abajo | Probar con keys reales (Claude, GHL); contratos de Meta Lead Ads y email sin verificar |
| 1 | Revival de leads (GHL) | **HECHA en local (modo mock/live)** — ver abajo | Probar con keys reales; contratos de GHL (búsqueda de contactos, conversations/messages, custom fields) y del webhook de respuestas entrantes sin verificar |
| 6 | Conversational Qualifier + Booking (GHL) | **HECHA en local (modo mock/live)**: 4 workflows (Inbound, Booking, Send Message, Stale & Queue). Spec en `docs/specs/conversational-qualifier-booking.md`. Prueba `scripts/smoke-qualifier.ps1`: 34 comprobaciones, todas PASS con datos sintéticos | Probar con keys y sub-cuenta reales de GHL; contratos de webhook entrante, Conversations, Calendars (slots y cita) y tags SIN verificar. Handoff = email con resumen (no reutiliza la Review Page todavía). Ver `docs/NEXT-STEPS.md` |
| 4 | Soporte con tickets y RAG (Support Reply Agent) | **HECHA en local (modo mock/live)**: 2 workflows (Ticket Reply Agent, KB Ingest) + pgvector en contenedor aparte. Plan en `docs/specs/support-reply-agent.md`, resumen en `docs/support-reply-agent-overview.md`. `scripts/smoke-support.ps1`: 31 PASS. Evaluación de 30 tickets (`docs/evals/support-eval.md`): 0 respuestas automáticas incorrectas | Probar con Claude, un proveedor de embeddings (256 dim.) y Gmail reales: contratos SIN verificar. Embeddings locales = palabras, no significado: el % de aciertos no mide un modelo real. Consulta real de pedidos pendiente |
| 2 | Intake legal (Clio) | — | Extracción de datos del caso, conflicto de interés, matter en Clio |
| 3 | Pipeline e-commerce (Shopify) | — | Validación SKU/variantes/precios, copy con voz de marca, revisión en Sheets, API Shopify |

## #5 — Calificación de leads + reporte semanal (hecha)

Workflows: `Lead Intake & Qualification (Auditable)` (77 nodos) y `Weekly Lead Report (Auditable)` (31 nodos).

| Pieza | Cómo | Verificado |
|---|---|---|
| Canales de entrada | `lib/adapt.js`: payload plano, Meta Lead Ads (`field_data`) y email (`from/subject/body`) | Sí, con payloads simulados. La forma real de Meta/email es un SUPUESTO |
| Enriquecimiento | `lib/enrich.js`: dominio, empresa y país deducidos solo si faltan; lo declara en `enriched_fields` | Sí |
| ICP configurable | Bloque `icp` en el nodo Config: alimenta las reglas (industria, mínimos, países) y el prompt de Claude | Sí (reglas). El efecto en Claude real no se probó |
| Asignación | Round-robin con `nextval()` de una secuencia (atómico) entre `salesReps` del Config | Sí: reparto 2/2 |
| Primer mensaje | Claude redacta el borrador (mock en local); el **vendedor** aprueba por email; solo entonces se envía al lead | Sí: aprobado → enviado; rechazado → no se envía; sin respuesta → no se envía |
| Reporte semanal | Cron lunes 08:00 + webhook manual. Cifras = SQL; narrativa = Claude o mock sobre esas cifras. Idempotente por semana ISO | Sí (el cron no se esperó hasta el lunes; se probó el disparador manual) |
| Fallo de IA | Lead: `ai_failed` → humano, sin mensaje al lead. Reporte: sale con resumen determinístico y lo declara | Sí |

Defectos encontrados y corregidos durante la #5: `null >= 0` marcaba leads sin tamaño como "bajo el mínimo del ICP"; un `\b` mal escapado dejó caracteres backspace en una regex (el borrador salía en inglés); un lead rechazado por inyección aparecía como "top lead" en el reporte; `temperature: 0` quitado del request a Claude (algunos modelos nuevos lo rechazan — no verificado con key real).

## #1 — Revival de leads (hecha)

> **Actualización v2 (2026-10-23):** el Daily Run ahora prepara los borradores reales y envía un link a una página de revisión (enviar / editar / saltar por lead) en vez de aprobar el lote a ciegas. Se añadieron horario de envío por zona del contacto (9–19 h, lunes a viernes), `Send Queue` (cada 15 min libera lo retenido) y un dashboard de solo lectura. Son 7 workflows de revival (Daily Run, Prepare Draft, Review Page, Send Touch, Send Queue, Handle Reply, Dashboard). Verificado en mock con datos sintéticos. El texto de abajo describe la v1: lo de "aprobación del lote" y "sin horario de silencio" ya quedó superado.

Tres workflows (v1): `Revival · Daily Run` (38 nodos), `Revival · Send Touch` (64) y `Revival · Handle Reply` (79). Datos sintéticos en `db/seed-revival.sql` (25 contactos con duplicados, inválidos, bajas, uno reciente y uno con inyección en el historial).

| Pieza | Cómo | Verificado |
|---|---|---|
| Selección | SQL (inactivos + toques vencidos) → `lib/revival.js selectCandidates`: inválidos, bajas, duplicados por email/teléfono, ya-en-secuencia, follow-ups primero, tope | Sí |
| Aprobación del lote | Un email por corrida con quién y qué toque; **sin lote `approved` no sale nada**. Timeout/ambiguo = no aprobado | Sí |
| Guarda al enviar | Send Touch re-evalúa en el momento: lote aprobado, lista de bajas (otra vez), estado válido, orden de toques. No confía en quien llama | Sí: token falso, lote pendiente, baja por email y por teléfono, toque fuera de orden, toque repetido |
| Mensaje | Claude (mock en local) a partir del historial (dato NO confiable). Código determinístico: pie de baja, rechazo de URLs / promesas de precio o garantía / mensajes largos | Sí: el historial con inyección quedó **bloqueado**, contacto en `needs_review`, alerta, nada enviado |
| Secuencia | Hasta 3 toques, espera 3 y 5 días (configurable), estado en `revival_state` | Sí (el reloj se adelanta por SQL; no se esperaron días reales) |
| Respuestas | Baja detectada **antes de la IA** (determinístico, la IA no puede deshacerla) → clasificación → enrutado fijo. Interés/agendar: el dueño aprueba y el link de booking lo pone el código | Sí: interesado, agendar, STOP, "no me escriban", no interesa, poco claro, repetida, contacto inexistente |
| Custom fields | Mirror local + (live) PUT a GHL con backoff | Mirror sí; GHL live solo hasta el `401` con token falso |
| Idempotencia | Por corrida/día, por toque y por respuesta. Concurrencia real: 202 + 200 duplicate | Sí |
| Fallos | IA caída → no se envía, estado intacto, clave `failed` (se reintenta), alerta. Envío CRM `401` → igual, sin reintentos inútiles. Custom fields live caído → persiste y alerta | Sí |

Defectos encontrados y corregidos: normalización de teléfono (un número de 11+ dígitos sin "+" ya trae su código de país: Bruno aparecía duplicado); un duplicado de alguien ya en secuencia recibía primer toque (ahora `already_in_sequence`); un script mío dejaba el lote cerrado y no probaba las guardas.

Límites: la forma real del webhook de respuestas de GHL, la API de contactos/mensajes/custom fields de GHL y el comportamiento de un SMS real están SIN verificar. En live el envío es SMS (requiere teléfono). Sin horario de silencio ni zona horaria por contacto (pendiente antes de producción). La llamada interna Daily Run → Send Touch usa un token compartido en el Config: en producción, Header Auth real con secreto.

## Pendiente transversal
- Panel de métricas sobre `v_run_summary` / `v_daily_metrics` (Next.js + Tailwind, tu stack) — se construye cuando haya 2+ automatizaciones.
- Slack como canal de aprobación (requiere crear la Slack app y pasar el token).
- Todas las APIs externas se construyen con modo `mock`; los contratos reales no se verifican hasta tener credenciales de prueba.
- Datos reales (p.ej. Rodrigo) nunca entran al repo: demos con datos sintéticos.

## Catálogo de flujos del 28-oct-2026 (`n8n-flujos-catalogo.pdf`, 51 páginas)

Documento de trabajo con la descripción y la guía de construcción de 18 sistemas. Las puntuaciones de los existentes las dio el agente de n8n; las prioridades 1–5 de los propuestos las fijó David. En los propuestos **no hay nada construido**: son especificaciones de diseño. Las cifras de prueba del PDF son las de este repositorio (31/31, 10 casos, 30 tickets), sin métricas de negocio ni clientes.

### Existentes (construidos y probados)

| # PDF | Sistema | Puntuación | Estado |
|---|---|---|---|
| 1 | Lead Revival (5 workflows) | 9/10 | Construido y probado |
| 2 | Support Reply Agent (RAG) | 9/10 | Construido y probado (modo mock, datos sintéticos) |
| 3 | SMS Qualifier + Booking | 8.5/10 | Construido y probado (10 casos); todavía sin cliente real |
| 4 | Lead Intake & Qualification | 8/10 | Construido y probado |
| 5 | Revival Review Page | 7.5/10 | Construido y probado |
| 6 | Weekly Lead Report | 7/10 | Construido y probado |
| 7 | Global Error Handler | 6.5/10 | Construido y probado |

### Propuestos (solo diseño)

| # PDF | Sistema | Prioridad | Sector | Stack propuesto | Qué haría |
|---|---|---|---|---|---|
| 8 | Invoice & Receipt Processor | **1** | Finanzas / e-commerce | Gmail, Claude (visión), Sheets/Airtable, Drive, Slack | Extrae los campos de facturas y recibos que llegan por email con confianza y evidencia por campo, valida la aritmética, detecta duplicados, archiva en Drive y pide aprobación en Slack |
| 9 | Listing Inquiry Agent + Showing Follow-up | **2** | Real estate | GHL, Claude, Postgres/Sheets, GHL Calendars | Responde preguntas de un inmueble solo con su ficha, agenda visitas reutilizando el motor del SMS Qualifier y hace el seguimiento después de la visita |
| 10 | No-show Reducer | **3** | Clínicas | Calendario/GHL, SMS o WhatsApp, Claude (solo texto libre) | Recordatorios a 48 h y 2 h con respuestas numéricas procesadas sin IA, reagendar, cancelar y lista de espera |
| 11 | Order Issue Agent + Review Responder | **4** | E-commerce | Gmail/helpdesk, Shopify/WooCommerce, Claude, Slack, Postgres | Responde estado y seguimiento de pedidos con datos reales; escala reembolsos, daños y clientes molestos; redacta respuestas a reseñas con aprobación |
| 12 | Client Onboarding | **5** | Operaciones | Formulario, firma electrónica, Drive/Docs, Notion, Slack, Gmail | Crea carpetas, genera y envía el contrato, crea el proyecto y las tareas al firmarse y arranca la secuencia de bienvenida |
| 13 | Ticket Triage + SLA Watcher | — | Soporte | Gmail/helpdesk, Claude, Slack, Postgres | Clasifica prioridad, asigna, calcula el SLA y avisa antes de que se incumpla |
| 14 | Content Repurposer | — | Marketing | RSS/YouTube/Drive, Claude, Notion/Sheets, Slack | De una pieza larga genera variantes por canal como borradores para aprobar; nada se publica solo |
| 15 | Ads Weekly Report | — | Marketing | Meta Marketing API, Google Ads API, Postgres/Sheets, Claude | KPIs por SQL (gasto, CTR, CPA, ROAS, variación) y Claude solo narra los cambios |
| 16 | Payment Reminders | — | Operaciones / finanzas | Stripe/contabilidad/Sheets, Gmail, SMS o WhatsApp, Postgres | Secuencia escalonada de cobro con tono creciente; se detiene al registrarse el pago y escala disputas |
| 17 | CV Screener | — | Reclutamiento | Gmail/formulario, Claude, Sheets/Airtable, Slack | Compara cada CV con los requisitos con evidencia citada; la IA no rechaza a nadie, una persona decide |
| 18 | WhatsApp Intake (Cloud API) | — | Cualquier sector | WhatsApp Cloud API, Drive, Claude, Sheets/CRM | Recibe mensajes y archivos, los guarda por contacto, extrae datos con evidencia, registra y confirma |

**Orden sugerido de construcción (Anexo B del PDF):** 8 → 9 → 10 → 11 → 12; el resto (13–18) según la demanda de las ofertas que lleguen.
Por qué: 8 es una demo muy visual con demanda transversal; 9 y 11 extienden sistemas que ya existen (SMS Qualifier y Support Reply Agent); 10 tiene un dolor fácil de medir; 12 sirve también para el propio negocio.

### Notas de encaje con este repositorio
- El PDF no incluye el **CRM ↔ Sheets Sync con dedupe** (**construido el 2026-10-30**, mock; ver `docs/specs/crm-sheets-sync.md`) ni los otros pendientes anteriores (legal Clio, e-commerce Shopify). **WhatsApp Intake** sí aparece (#18, sin prioridad numérica).
- Cada propuesto reutiliza patrones ya construidos: config + modo mock/live, reintentos con backoff, salida validada en código, datos externos como no confiables, bajas sin IA, idempotencia, log por paso y aprobación humana.
- Los nombres del PDF difieren de los de este repo (por ejemplo, "SMS Qualifier + Booking" = Conversational Qualifier + Booking, #6 arriba).


## Roadmap unificado (2026-10-30)

Une el catálogo del 28-oct con «workflows más pedidos» (116 ofertas, 26–30 oct). Demanda = menciones por categoría en el PDF (una oferta puede estar en varias).

| Orden | Sistema | Demanda | Estado |
|---|---|---|---|
| — | Lead Intake, Weekly Report, Revival, Qualifier + Booking, Support Reply Agent | — | Hechos (mock, datos sintéticos) |
| 1 | **CRM ↔ Sheets Sync** | 50 | **Hecho (mock)** — 40/40 smoke, adaptadores live sin construir |
| 2 | Invoice & Document Processor (#8 + #13) | 33 | **Hecho (mock)** — 34/34 smoke, extracción live y contabilidad live sin verificar |
| 3 | Email / Ticket Triage + SLA Watcher (#4 + #13) | 24 | **Hecho (mock)** — 66/66 smoke, 26 tests de lib; Gmail/helpdesk reales y Claude en vivo sin verificar |
| 4 | Recordatorios + No-show (#5) | 24 | Pendiente |
| 5 | Client Onboarding (#7) | 23 | Pendiente |
| 6 | SOP Generator (#6) | 23 | Pendiente |
| 7 | E-commerce (Order Issue + Review Responder) | 18 | Pendiente (necesita tienda de desarrollo Shopify) |
| 8–10 | Payment Reminders, WhatsApp Intake, Ads Weekly Report | dentro de #8 / #12 / #3 | Pendiente |
| 11 | Content Repurposer | 15 | Pendiente (baja prioridad) |
| 12 | Voice Agent | 10 | Pendiente (no se prueba en local) |
| — | Listing Inquiry, CV Screener, Intake legal (Clio) | sin respaldo en el PDF | En espera |
