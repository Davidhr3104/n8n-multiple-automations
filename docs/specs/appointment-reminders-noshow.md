# Appointment Reminders + No-show Reducer — plan

Objetivo: que menos gente falte a su cita. Recordatorios a 48 h y 2 h; el cliente responde con un número (1 confirmar, 2 reagendar, 3 cancelar) y **el código** lo procesa sin IA; una cita cancelada o movida libera el horario y se ofrece a la lista de espera; quien no llega recibe un seguimiento una sola vez; los reincidentes se señalan a una persona (nunca se bloquean solos).
La IA solo interviene con texto libre, y solo para clasificar la intención con evidencia y confianza.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Respuestas | Números y palabras exactas las resuelve el código. Texto libre → IA clasifica (confirmar / reagendar / cancelar / otra); si hay duda, inyección o IA caída → una persona | La mayoría de las respuestas son "1", "2", "3": no necesitan un modelo |
| Reagendar | Se crea una cita NUEVA enlazada y la vieja queda `rescheduled` | Los recordatorios van por cita: una cita nueva tiene sus propios recordatorios sin pisar el historial |
| Un horario, una persona | `UPDATE … WHERE status = 'free'` dentro de UNA sentencia: si dos personas eligen el mismo horario, solo una gana y la otra recibe opciones nuevas | Sin dobles reservas aunque lleguen a la vez |
| Recordatorios | Ventanas por cita (48 h: entre 48 y 24 h antes; 2 h: entre 2 h y 30 min antes), horario de envío por zona del contacto (reutiliza `lib/schedule.js`), baja respetada | Un recordatorio de 48 h no sale cuando la cita se creó hace 3 horas |
| Registro del envío | Se registra DESPUÉS de enviar (clave `cita|tipo`). Un envío fallido se reintenta en la siguiente corrida y falla ruidosamente | Mismo patrón que las alertas de SLA |
| Fuera de horario | Se difiere; si ya no habrá otra oportunidad antes de que la ventana se cierre, se registra como `omitido` con el motivo (nunca se pierde en silencio) | |
| No-show | Pasados 15 min de gracia sin check-in, el barrido marca `no_show` y envía UN seguimiento con la oferta de reagendar. El personal puede corregir (asistió) | Un no-show equivocado no debe castigar al cliente |
| Reincidencia | ≥ 2 no-shows en 90 días → aviso al responsable. No hay bloqueo ni cobro automáticos | Decisión de política = humana |
| Lista de espera | Al liberarse un horario se ofrece al primero en la lista; "1" lo toma (gana el primero en responder); "no" pasa la oferta al siguiente | |
| Calendario | Tabla `appt_slots` (mock). En live: GoHighLevel / Google Calendar, contrato SIN verificar | |
| Tiempo en pruebas | `now` y `received_at` solo con token y `allowTimeOverride` (mock) | Pruebas determinísticas sin esperar horas |

## Workflows

1. **reminders-send** (cron 10 min + webhook de demo): lee citas activas, calcula qué recordatorios tocan, envía, registra lo enviado y deja la conversación esperando respuesta.
2. **reminders-reply** (`POST /webhook/reminder-reply`): baja primero; idempotente por `message_id`; el código interpreta o la IA clasifica texto libre; aplica el efecto en una sentencia atómica; responde al cliente; ofrece el horario liberado a la lista de espera.
3. **reminders-noshow** (cron 15 min + webhook de demo): marca no-shows, envía el seguimiento una vez, avisa reincidentes.
4. **reminders-staff** (`POST /webhook/appt-update`): check-in, asistió, cancelar o no-show manual, con auditoría de quién y cuándo.

## Fuera de alcance / sin verificar
- SMS/WhatsApp y calendario reales (GHL): en local el SMS es un correo a Mailpit.
- Claude en vivo (herramienta `record_reply_intent`).
- Las ofertas a la lista de espera no caducan solas; si el primero no responde, el horario sigue libre para cualquiera que lo elija.
- Un horario libre puede ser tomado por otro cliente mientras se ofrece (gana el primero), por diseño.
