# Plan — Agentes de llamada (Vapi + n8n) para Online Movers & Storage

Objetivo: replicar los agentes de Dapta (Sofia EN/ES, Carmen EN/ES) en Vapi, con n8n como tronco determinístico y
auditable, para comparar contra Dapta con la misma llamada de prueba. Estado: **PLAN, nada construido.**

## Decisiones tomadas

- Plataforma de voz: **Vapi** (asumida por defecto; Retell queda como alternativa si Vapi falla en la prueba).
- 4 agentes: Sofia EN (entrada), Sofia ES, Carmen EN, Carmen ES. Un agente por idioma, con reconocimiento de voz y voz propios.
- MVP solo **llamada web** (sin teléfono, sin salida, sin SMS, sin HubSpot).
- Rama de **reclamos APAGADA** por bandera en n8n (la descripción de Dapta dice "OFF hasta que firme el abogado"; su prompt la trae activa).

## Separación determinístico vs. IA

| Determinístico (n8n, no negociable por el modelo) | Juicio de IA (agente de voz) |
|---|---|
| Número de caso `CS-YYYYMMDD-###` | Conversar y recoger datos |
| Promesa de tiempo según hora/día de la llamada | Detectar intención y emoción |
| Bandera de reclamos, lista de temas urgentes (lesión, abogado) | Resumir el caso |
| Horario de contacto de salida, STOP | Elegir la rama dentro de las permitidas |
| Log de ejecución, idempotencia, errores visibles | |

Regla: el agente pide a n8n lo que puede decir (número de caso, promesa de tiempo). No lo inventa.

## Flujo de transferencias (todas con contexto)

- Sofia EN → Sofia ES (cliente pide español) · Sofia EN → Carmen EN (no es venta)
- Sofia ES → Carmen ES (mantiene idioma, no vuelve a preguntarlo)
- Carmen EN → Carmen ES (cliente pide español)
- Carmen → Sofia (venta nueva): **asíncrono**, solo se anota para contacto posterior.
- Payload de transferencia: idioma, nombre, teléfono, resumen del caso, datos ya recogidos.

## Contrato n8n (por definir al construir)

- Webhook al finalizar la llamada: transcripción, resumen, datos extraídos, motivo de fin, agente, idioma.
- Herramienta `open_case` (llamada en vivo): devuelve `case_id` y `promise_text`.
- Persistencia en Postgres (misma fundación: `execution_log`, `idempotency_keys`) + tabla de llamadas con
  `confidence` y `needs_human`.
- Casos urgentes (lesión, abogado): `needs_human = true` + aviso inmediato a una persona (destino por definir).
- Escalamiento: 2 fallos de comprensión seguidos → transferir a humano, no colgar por inactividad.

## Pasos

1. **Cuenta y secretos.** API key de Vapi en `.env` (nunca en el repo ni en chat). Verificar: key válida con una llamada de lectura.
2. **Túnel público** para el webhook (cloudflared/ngrok) → n8n local. Verificar: petición externa llega al webhook.
3. **Workflow n8n `voice-call-ingest`**: webhook, idempotencia, log, guardado. Verificar con payload simulado + duplicado (patrón de la fundación).
4. **Tool `open_case`** en n8n. Verificar: dos llamadas el mismo día → `-001`, `-002`; promesa distinta dentro y fuera de horario.
5. **Sofia EN** en Vapi (prompt de Dapta, saludo en dos turnos como dice su prompt). Verificar: llamada web en inglés completa una cotización con datos extraídos.
6. **Sofia ES** + transferencia EN→ES. Verificar: cambio de idioma a mitad de llamada sin repetir el saludo ni pedir de nuevo datos ya dados.
7. **Carmen EN/ES** + transferencias desde Sofia. Verificar: caso queda con `case_id` y el contexto de Sofia.
8. **Prueba comparativa vs. Dapta:** mismo guion, mismo teléfono/micrófono, mismas frases (incluida una con acento y otra con ruido). Registrar entendimiento, latencia, traspasos, trazabilidad.

## Asunciones SIN verificar

- Verificado en docs.vapi.ai (2026-10-20): Squads con herramienta `handoff` (`destinations` + `description`) conservan el contexto de la conversación; cada miembro puede tener su propia `voice`; el `transcriber` (`provider`, `model`, `language`) se configura por asistente (Deepgram `nova-2`/`nova-3`, `language: "multi"` para detección automática). SIN verificar: que el `language` del transcriber se respete por miembro dentro de un Squad (la página de Squads no lo dice; se infiere porque cada miembro es un asistente). Comprobar leyendo la config tras crearlos, y con una llamada.
- Diseño derivado: los agentes de entrada (Sofia EN, Carmen EN) usan `language: "multi"` para entender a quien empiece en español antes de transferir; los ES fijan `es`.
- Paso de variables entre miembros: la doc no da un campo directo; se hace con extracción de variables/resumen en el handoff. Probar que nombre, teléfono y resumen llegan.
- Que la hipótesis del fallo de Dapta (reconocimiento en inglés tras pasar a español) sea la causa real; no se ha visto su configuración.
- Los prompts en español: traducción propia, **requieren revisión de un hablante nativo** del español de los clientes de Miami.

## Preguntas abiertas para Jesús

- Fragmento cortado en la rama COI del prompt de Carmen ("Sent is not accepted").
- ¿Quién recibe los avisos urgentes y por qué canal?
- Promesa de tiempo de Carmen (L-V 9–6) vs. horario de la empresa (7 días, 8–8): ¿cuál manda?
- Prompts de Sofia ES y Carmen ES originales, si existen.
- ¿Quién autoriza encender la rama de reclamos y cuándo?
