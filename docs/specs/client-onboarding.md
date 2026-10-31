# Client Onboarding — plan

Objetivo: cuando se cierra un cliente, pasar de "cerrado" a "arrancado" sin que nadie copie datos a mano: contrato, carpeta, proyecto con tareas, CRM, aviso al equipo y una secuencia de bienvenida. **El contrato lo escribe una plantilla, nunca la IA.** La IA solo resume las notas del formulario en requisitos con evidencia; el código descarta lo que no esté en el texto.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Quién escribe el contrato | Plantilla por paquete rellenada por código | Un contrato inventado por un modelo es un riesgo legal |
| Cuándo sale solo | Solo si el paquete es estándar, el monto está bajo el límite, no hay términos especiales en las notas, no es un cliente duplicado y no hay intento de inyección. Si no, **el responsable aprueba** (email enviar-y-esperar) antes de enviar | El envío de un contrato es una acción hacia fuera |
| IA | Resume las notas en requisitos, cada uno con la cita textual; el código verifica la cita y solo los requisitos fundamentados se vuelven tareas | La IA no puede crear trabajo que el cliente no pidió |
| Firma | Enlace con un token de un solo uso (generado en Postgres), con caducidad. En live: Dropbox Sign / DocuSign (contrato SIN verificar) | Un token inválido, repetido o caducado no firma nada |
| Qué pasa al firmar | Cadena de pasos idempotentes y registrados uno a uno (`onb_steps`): carpeta → proyecto y tareas → CRM → secuencia de bienvenida → aviso al equipo → activo | Si un paso falla se ve, y volver a llamar a la firma **reanuda** sin duplicar nada |
| Fechas de las tareas | Días laborables desde la fecha de inicio, con festivos configurables | Reproducible y auditable |
| Secuencia de bienvenida | Bienvenida, seguimiento a los 2 días laborables y recordatorio del arranque; respeta baja y horario de envío; se detiene si el cliente se da de baja o el proyecto se cancela | |
| Contratos sin firmar | Recordatorio una vez a los 3 días, aviso al responsable a los 7, caducan a los 14 | Nada queda pendiente en silencio |
| Registro | Cada paso, quién y cuándo, en `onb_events`; errores visibles | |
| Tiempo en pruebas | `now` solo con token y en mock | |

## Workflows

1. **onboarding-start** (`POST /webhook/onboarding-start`): valida, idempotente por `client_id`, reglas duras, duplicados, resumen de notas (IA lee), contrato por plantilla, compuerta (automático o aprobación), envía el contrato y deja constancia.
2. **onboarding-signed** (`POST /webhook/onboarding-sign`): verifica el token, firma de forma atómica, aprovisiona (carpeta, proyecto, tareas, CRM, secuencia, aviso) y activa; reanudable.
3. **onboarding-sequence** (cron 15 min + webhook de demo): envía la secuencia de bienvenida, recordatorios de contrato, escalamiento y caducidad, y avisa de aprovisionamientos atascados.

## Fuera de alcance / sin verificar
- Drive, Notion/Asana, Slack, firma electrónica y CRM reales: en local son tablas y correos a Mailpit.
- Claude en vivo (herramienta `record_intake_summary`).
- Pagos y facturación del cliente nuevo.
