# Lead Intake & Qualification — automatización auditable en n8n (local, gratis)

Flujo de captura y calificación de leads con IA **auditable**: reglas determinísticas + juicio de Claude con
nivel de confianza y citas verificadas + aprobación humana en casos de riesgo + un archivo de evidencia por lead.

```
Webhook → Config → Validar → 202/422
   → Reglas (determinístico) → Claude o Mock (juicio) → Compuerta (determinístico)
   → ¿necesita humano? ─sí→ Email Aprobar/Rechazar → ¿aprobado?
   → CRM (GoHighLevel o mock) → ¿hot? → notificar → Auditoría (./audit/<lead_id>.json) → Assert
Cualquier error → Global Error Handler → email de alerta
```

## Arranque

```bash
docker compose up -d          # n8n :5678, Mailpit :8025
powershell -File scripts/deploy.ps1   # build + importa credenciales/workflows + publica + reinicia
powershell -File scripts/smoke-test.ps1   # 5 leads de prueba
```

- n8n: http://localhost:5678 (crea tu cuenta owner local la primera vez)
- Emails capturados (aprobaciones, alertas): http://localhost:8025
- Evidencia: carpeta `audit/` (un JSON por lead, incluye reglas, salida de IA, decisión, humano, CRM, ejecución)

## Dónde conectas tus APIs

| Qué | Dónde | Cómo |
|---|---|---|
| Claude | Credencial **Anthropic API (PLACEHOLDER)** en n8n | Header Auth: `x-api-key` = tu key. Luego `aiMode: "live"` |
| GoHighLevel | Credencial **GoHighLevel (PLACEHOLDER)** | Header Auth: `Authorization` = `Bearer <token>`. Pon `ghlLocationId` y `crmMode: "live"` |
| Email real | Credencial **Mailpit (local SMTP)** | Cámbiala por tu SMTP cuando salgas de local |

Umbrales y modos viven en el nodo **Config** (o con `AI_MODE=live CRM_MODE=live` al hacer deploy).

## Principios de diseño

- **Determinístico vs. juicio**: `lib/` (normalizar, reglas, compuerta) no usa IA; la IA solo puntúa. La decisión final es de la compuerta.
- **Citas verificadas**: las citas que Claude devuelve deben aparecer textualmente en el mensaje; si no, se descartan y la confianza se limita a 0.5.
- **Nunca en silencio**: IA caída → `ai_failed` → humano. Timeout humano → no aprobado (falla cerrado). CRM caído → se escribe la auditoría y luego falla ruidosamente (alerta por email).
- **Entrada no confiable**: el mensaje del lead va dentro de `<lead_message>`, con instrucción de ignorar órdenes; intentos de inyección se marcan y exigen humano. En el email de aprobación se neutralizan `& < >`.

## Tests

```bash
npm test      # 23 tests unitarios de lib/ (sin n8n)
```

## Estado de verificación (2026-10-13)

Verificado en local con n8n 2.43.4: rutas aprobada/rechazada por humano, automática, inválida, inyección,
fallo de IA (401 real de Anthropic con key falsa) y fallo de CRM (401 real de GHL con token falso).

**NO verificado**: respuesta de Claude con una key real (forma del request/tool_use validada solo hasta el 401),
contrato de `contacts/upsert` de GoHighLevel, comportamiento exacto del timeout de 24 h del nodo de espera
(se asume falla cerrado), uso en producción (auth del webhook, HTTPS, backups).

## Siguientes pasos de hardening

Auth del webhook (Header Auth), rate limiting, HTTPS/reverse proxy, backup del volumen `n8n_data` y de `N8N_ENCRYPTION_KEY`,
migrar el modo de task runners a `external` (n8n lo marca como deprecado en internal).
