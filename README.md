# Lead Intake & Qualification — automatización auditable en n8n (local, gratis)

Flujo de captura y calificación de leads con IA **auditable**: reglas determinísticas + juicio de Claude con
nivel de confianza y citas verificadas + aprobación humana en casos de riesgo + un archivo de evidencia por lead.

```
Webhook (plano / Meta / email) → Config → Validar → idempotencia → 202/422/200
   → Enriquecer → Reglas vs ICP (determinístico) → Claude o Mock (juicio) → Compuerta (determinístico)
   → ¿necesita humano? ─sí→ Email Aprobar/Rechazar → ¿aprobado?
   → CRM (GoHighLevel o mock) → ¿hot? → vendedor (round-robin) → aprueba borrador → primer mensaje → Auditoría (./audit/<lead_id>.json) → Assert
Cada paso → Postgres (execution_log) · clave de idempotencia por lead · cualquier error → Global Error Handler → log + email
```

## Arranque

```bash
docker compose up -d          # n8n :5678, Mailpit :8025, Postgres :5432
powershell -File scripts/deploy.ps1 -WithCredentials   # primera vez: build + importa credenciales y workflows + publica + reinicia
powershell -File scripts/deploy.ps1                    # después: sin -WithCredentials, para no pisar tus keys reales
powershell -File scripts/smoke-test.ps1 -Clean -AutoApprove -Report   # 9 leads, aprobaciones automáticas y reporte semanal
```

- n8n: http://localhost:5678 (crea tu cuenta owner local la primera vez)
- Emails capturados (aprobaciones, alertas): http://localhost:8025
- Log por paso: `docker exec postgres psql -U automations -d automations -c "SELECT * FROM v_run_summary"` (mismo SQL que Supabase: `db/init.sql`)
- Evidencia: carpeta `audit/` (un JSON por lead, incluye reglas, salida de IA, decisión, humano, CRM, ejecución)

## Dónde conectas tus APIs

| Qué | Dónde | Cómo |
|---|---|---|
| Claude | Credencial **Anthropic API (PLACEHOLDER)** en n8n | Header Auth: `x-api-key` = tu key. Luego `aiMode: "live"` |
| GoHighLevel | Credencial **GoHighLevel (PLACEHOLDER)** | Header Auth: `Authorization` = `Bearer <token>`. Pon `ghlLocationId` y `crmMode: "live"` |
| Email real | Credencial **Mailpit (local SMTP)** | Cámbiala por tu SMTP cuando salgas de local |

ICP, vendedores (`salesReps`), umbrales y modos viven en el nodo **Config** (o con `AI_MODE=live CRM_MODE=live` al hacer deploy).

## Reporte semanal

Workflow `Weekly Lead Report`: cron lunes 08:00 o `POST /webhook/weekly-report` para demos. Llega por email (Mailpit).

## Revival de leads

Tres workflows: `Revival · Daily Run` (cron L-V 09:00 o `POST /webhook/revival-run`), `Revival · Send Touch` y `Revival · Handle Reply` (`POST /webhook/revival-reply`).

```bash
docker exec postgres psql -U automations -d automations -f /db/seed-revival.sql   # datos sintéticos (una vez)
powershell -File scripts/smoke-revival.ps1 -Clean     # corrida + seguimientos + respuestas + guardas
```

Parámetros en `build/workflows/revival-config.js` (inactividad, tope por corrida, espaciado, link de booking, modos). Para probar sin inundar de alertas: `REVIVAL_MAX=2` al hacer deploy.

## Fundación y roadmap

Ver [docs/ROADMAP.md](docs/ROADMAP.md): reintentos con backoff, log en Postgres, idempotencia, errores y aprobación como piezas comunes para las 5 automatizaciones planeadas.

## Principios de diseño

- **Determinístico vs. juicio**: `lib/` (normalizar, reglas, compuerta) no usa IA; la IA solo puntúa. La decisión final es de la compuerta.
- **Citas verificadas**: las citas que Claude devuelve deben aparecer textualmente en el mensaje; si no, se descartan y la confianza se limita a 0.5.
- **Nunca en silencio**: IA caída → `ai_failed` → humano. Timeout humano → no aprobado (falla cerrado). CRM caído → se escribe la auditoría y luego falla ruidosamente (alerta por email).
- **Entrada no confiable**: el mensaje del lead va dentro de `<lead_message>`, con instrucción de ignorar órdenes; intentos de inyección se marcan y exigen humano. En el email de aprobación se neutralizan `& < >`.

## Tests

```bash
npm test        # 67 tests unitarios de lib/ (sin n8n)
npm run check   # enlaces, sintaxis del código embebido y orden de las ramas de log en workflows/*.json
```

## Estado de verificación (2026-10-13)

Verificado en local con n8n 2.43.4: idempotencia, log por paso y backoff (ver ROADMAP), rutas aprobada/rechazada por humano, automática, inválida, inyección,
fallo de IA (401 real de Anthropic con key falsa) y fallo de CRM (401 real de GHL con token falso).

**NO verificado**: respuesta de Claude con una key real (forma del request/tool_use validada solo hasta el 401),
contrato de `contacts/upsert` de GoHighLevel, comportamiento exacto del timeout de 24 h del nodo de espera
(se asume falla cerrado), uso en producción (auth del webhook, HTTPS, backups).

## Siguientes pasos de hardening

Auth del webhook (Header Auth), rate limiting, HTTPS/reverse proxy, backup del volumen `n8n_data` y de `N8N_ENCRYPTION_KEY`,
migrar el modo de task runners a `external` (n8n lo marca como deprecado en internal).
