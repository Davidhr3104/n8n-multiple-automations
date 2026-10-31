# Payment Reminders — resumen

Cobra facturas vencidas con una secuencia escalonada y educada que se detiene sola al pagar. Plan y decisiones: `docs/specs/payment-reminders.md`.

**Modo mock, datos sintéticos.** Stripe / contabilidad, SMS o WhatsApp reales y Claude en vivo: sin verificar.

## Cómo funciona
1. `pay-ledger`: `POST /webhook/pay-invoice` (alta idempotente; mismo id con datos distintos = 409 visible) y `POST /webhook/pay-payment` (idempotente por `payment_id`; el saldo se suma con un `UPDATE` atómico; un sobrepago avisa a una persona).
2. `pay-dunning` (cron diario 09:00 + `POST /webhook/pay-run`): upcoming (−3 d), due (0), overdue1 (+7), overdue2 (+14), final (+30, avisa a una persona, no al cliente). Un mensaje por cliente, solo la etapa más reciente, dentro del horario local, sin bajas, sin pausas, sin disputas.
3. `pay-reply` (`POST /webhook/pay-reply`): STOP lo lee el código; el resto lo clasifica la IA con una cita que el código verifica; el código decide. Nada se contesta al cliente automáticamente.

## Qué decide el código y qué la IA
| La IA | El código |
|---|---|
| Elige una intención (ya pagué / disputa / pagaré / otra) y cita la frase | Saldos, etapas, horarios, bajas, tono (plantillas), la fecha de una promesa, qué cambia en la factura y a quién se avisa |

## Probado (`scripts/smoke-payments.ps1`: 54 comprobaciones; `test/payments.test.js`: 13 tests)
Validación e idempotencia; conflicto de factura; pagos parciales/duplicados/sobrepago; dos pagos simultáneos; etapas con agrupación por cliente; horario local; la secuencia se detiene al pagar; etapa final a una persona; una etapa saltada queda `superseded`; STOP, ya pagué (pausa, no marca pagado), disputa, promesa con fecha del código, promesa lejana o sin fecha, inyección, IA caída; idempotencia de respuestas.

## Defectos encontrados al construirlo
- `pay-reply` no cerraba la clave de idempotencia (quedaba en `processing`): se veía en el log de errores, no en el smoke. Corregido y con comprobación.
- Defecto anterior, en el barrido de no-shows de Recordatorios: un contacto con dos citas sin asistir en la misma corrida rompía el registro (`ON CONFLICT DO UPDATE ... second time`) y, como el envío ya había salido, se reenviaba en cada corrida. Corregido con `DISTINCT ON`.

## Límites
- Entre leer y enviar pasan segundos: un pago que llegue justo en ese intervalo no frena ese mensaje.
- Una factura se da de alta una sola vez; corregir un importe requiere un flujo que no existe todavía.
- Una disputa pone en disputa todas las facturas abiertas de ese contacto (no sabemos de cuál habla); una persona decide.
- Sin recargos por mora, bloqueo de servicio ni agencias de cobro, por diseño.
