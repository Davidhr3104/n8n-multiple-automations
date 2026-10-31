# Ticket Triage + SLA Watcher — plan

Objetivo: cada ticket entrante se clasifica, recibe prioridad, se asigna a una persona y queda con fechas límite de SLA; un vigilante avisa **antes** de que se incumpla y escala cuando se incumple.
La IA solo LEE y resume el ticket. La prioridad final, la asignación y los plazos los decide código.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Quién decide la prioridad | Código. La IA propone una urgencia; reglas duras y el plan del cliente ponen **pisos** que la IA no puede bajar | La IA no debe poder "rebajar" un ticket de seguridad ni uno de un cliente enterprise |
| Prioridad máxima (P1) | Solo con **dos señales independientes** (regla dura o plan del cliente + propuesta de la IA con evidencia en el texto). Con una sola señal baja a P2 y se marca para triage humano | Un P1 falso despierta a todo el equipo; un P1 perdido se cubre con el piso de las reglas |
| Fundamentación | La IA debe citar el fragmento del ticket que respalda la categoría y la urgencia; si el fragmento no está en el texto, su confianza pasa a 0 | Mismo patrón que Invoice: nada que la IA diga sin evidencia mueve la decisión |
| Asignación | Código: personas activas con la habilidad de la categoría, con cupo, la de menos tickets abiertos (desempate por nombre). Sin candidatos → cola de triage humano | Sin IA; reproducible y auditable |
| SLA | Tabla por prioridad (primera respuesta y resolución). P1 en horas corridas; P2–P4 en horario laboral (L–V, con festivos configurables) | Horario laboral calculado por código con zona horaria fija (sin DST) |
| Vigilante | Cron cada 5 min. Aviso a ≥75 % del plazo, escalamiento al incumplir. Cada alerta se envía **una vez** (tabla `triage_sla_alerts`) y solo se registra DESPUÉS de enviarse | Si el email falla, se reintenta en la siguiente corrida y el Error Handler avisa: nunca en silencio |
| Detener el reloj | `POST /webhook/triage-update` (`first_response`, `resolve`, `reassign`) | Sin esto el SLA nunca termina |
| Entrada | Webhook `POST /webhook/triage-ticket` (en live: Gmail Trigger / helpdesk con el mismo payload normalizado) | Contrato live SIN verificar |
| Tiempo en pruebas | `received_at` (entrada) y `now` (vigilante) solo se aceptan con el token interno y `allowTimeOverride=true` (solo mock) | Permite probar el SLA de forma determinística sin esperar horas |

## Flujo — triage-intake

1. **Validar + token + idempotencia** por `ticket_id` (202 inmediato, duplicado 200).
2. **Reglas duras (código)**: temas sensibles (seguridad/fraude, legal, salud, disputa de pago) y palabras de caída de servicio fijan un **piso** de prioridad; intento de inyección se marca.
3. **Contexto (SQL)**: plan del cliente (`triage_customers`: enterprise/pro/free → piso), carga de cada agente.
4. **Clasificar (IA lee)**: ¿es un ticket real o spam?, categoría, urgencia propuesta, sentimiento, resumen, con evidencia y confianza.
5. **Fundamentar (código)**: la evidencia debe estar en el texto.
6. **Decidir (código)**: prioridad final = máx(piso de reglas, piso del plan, propuesta de la IA acotada); P1 solo con dos señales; confianza baja o inyección → triage humano.
7. **Asignar (código)** y **calcular SLA (código)**.
8. **Avisar** al asignado (y al líder si es P1, no hay asignado o hay revisión humana). Si el email falla, el flujo falla ruidosamente.
9. **Persistir** ticket + evento de auditoría en UNA sentencia; log por paso.

## Flujo — triage-sla-watch

Cron */5 + webhook de demo. Lee tickets abiertos, calcula por código el estado de cada reloj (ok / warning / breached), descarta alertas ya enviadas, arma un correo por destinatario, envía, registra las alertas enviadas y falla ruidosamente si algún envío falló.

## Flujo — triage-update

Registra primera respuesta / resolución / reasignación con quién y cuándo. Primera respuesta o resolución repetida es idempotente (no pisa la fecha original). Un ticket resuelto no puede volver a abrirse en esta versión.

## Fuera de alcance / sin verificar
- Gmail Trigger y helpdesk reales (el payload es el contrato).
- Claude en vivo: el contrato de la herramienta `record_triage` está sin verificar; el modo mock lee palabras clave y NO mide la calidad de un modelo.
- Pausa del reloj (esperando al cliente), hilos de seguimiento del mismo ticket, adjuntos, Slack.
- La asignación considera cupo y carga, no turnos ni vacaciones (solo `active`).
