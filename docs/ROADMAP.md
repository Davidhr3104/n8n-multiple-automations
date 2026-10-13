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
| 1 | Revival de leads (GHL) | — | Cron/webhook de inactivos, dedupe, mensaje personalizado, clasificador de respuesta, aviso con aprobación, custom fields + link de booking |
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

## Pendiente transversal
- Panel de métricas sobre `v_run_summary` / `v_daily_metrics` (Next.js + Tailwind, tu stack) — se construye cuando haya 2+ automatizaciones.
- Slack como canal de aprobación (requiere crear la Slack app y pasar el token).
- Todas las APIs externas se construyen con modo `mock`; los contratos reales no se verifican hasta tener credenciales de prueba.
- Datos reales (p.ej. Rodrigo) nunca entran al repo: demos con datos sintéticos.
