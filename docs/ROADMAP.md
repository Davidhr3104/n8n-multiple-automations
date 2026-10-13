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
| 4 | Soporte con tickets y RAG | — | pgvector (la misma imagen Postgres necesita la extensión), clasificador intención/sentimiento, RAG, escalamiento |
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

Tres workflows: `Revival · Daily Run` (38 nodos), `Revival · Send Touch` (64) y `Revival · Handle Reply` (79). Datos sintéticos en `db/seed-revival.sql` (25 contactos con duplicados, inválidos, bajas, uno reciente y uno con inyección en el historial).

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
