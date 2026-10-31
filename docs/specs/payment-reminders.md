# Payment Reminders — plan

Objetivo: cobrar facturas vencidas con una secuencia escalonada y educada que **se detiene sola en cuanto se paga**, agrupa por cliente y manda a una persona todo lo que no sea un recordatorio simple. **Los importes, fechas y el tono salen de SQL y de plantillas fijas; la IA solo clasifica una respuesta libre del cliente.** Nada se bloquea, se cobra ni se reembolsa automáticamente.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Etapas | upcoming (−3 d), due (0), overdue1 (+7), overdue2 (+14), final (+30) | Tono creciente pero siempre cortés; plantillas fijas, sin amenazas ni recargos |
| Etapa final | No manda nada al cliente: avisa a una persona | A los 30 días decide un humano (llamada, plan de pago) |
| Saldo | `amount − paid_total` en la base de datos; los pagos se suman con un `UPDATE` atómico por fila | Una IA nunca escribe un importe; dos pagos simultáneos no se pierden |
| Pago | Idempotente por `payment_id`; saldo cero = pagada = la secuencia se detiene; un sobrepago se señala a una persona (no se reembolsa solo) | |
| Qué se envía | Solo facturas `open` con saldo, sin pausa, sin baja y dentro del horario del cliente; un recordatorio atrasado no acumula etapas: se envía la más reciente y las anteriores quedan `superseded` | Nadie recibe tres correos el mismo día |
| Agrupación | Un solo mensaje por contacto con todas sus facturas vencidas | Menos ruido |
| Registro | Una etapa cuenta como enviada solo después de enviarse; si falla, se reintenta y falla de forma visible | |
| Respuesta del cliente | Baja (STOP) la lee el código antes de la IA. La IA solo clasifica: ya pagué, no estoy de acuerdo, pagaré el… , otra cosa. Con evidencia citada y confianza mínima | |
| «Ya pagué» | No marca nada como pagado: pausa 3 días y avisa a una persona que verifique | Un cliente puede equivocarse o mentir |
| Disputa | La factura pasa a `disputed`, la secuencia se detiene y avisa a una persona | Nunca se insiste sobre algo discutido |
| Promesa de pago | La fecha la extrae el código del texto (ISO o «in N days»), máximo 14 días, una vez por factura; si no, a una persona | La IA no inventa fechas |
| Tiempo en pruebas | `now` solo con token y en mock | |

## Workflows
1. **pay-ledger**: `POST /webhook/pay-invoice` (alta idempotente de factura) y `POST /webhook/pay-payment` (pago idempotente, parcial o total).
2. **pay-dunning**: cron diario 09:00 + `POST /webhook/pay-run`. Lee, planifica, envía, registra.
3. **pay-reply**: `POST /webhook/pay-reply`. Baja → código; el resto → IA clasifica → el código decide.

## Fuera de alcance / sin verificar
- Stripe / contabilidad / SMS o WhatsApp reales: en local son tablas y correos a Mailpit.
- Claude en vivo (herramienta `record_reply_intent`).
- Recargos por mora, bloqueo de servicio y agencias de cobro: no se hacen.
