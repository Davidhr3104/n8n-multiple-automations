# Siguientes automatizaciones — qué hacen y qué tan buenas son

Evaluación honesta de lo que sigue en el roadmap, ordenada por qué conviene construir primero.
"Valor de portafolio" = cuánto suma para mostrar a clientes o empleadores de automatización con IA (n8n + GHL + Claude).
Todo se construiría con datos sintéticos y modo `mock`, igual que lo hecho hasta ahora.

## Resumen

| Orden | Automatización | Esfuerzo | Valor de portafolio | Riesgo técnico | Recomendación |
|---|---|---|---|---|---|
| 1 | **#6 Conversational Qualifier + Booking** | 20–25 h (la spec dice 15–20) | Muy alto | Medio: estado de conversación y booking real de GHL | Construir primero |
| 2 | **#4 Soporte con tickets y RAG** | 20–30 h | Alto | Medio-alto: pgvector y calidad de recuperación | Segundo |
| 3 | **#2 Intake legal (Clio)** | 15–25 h | Medio-alto, nicho | Medio: datos sensibles y conflicto de interés | Tercero, si apuntas a despachos |
| 4 | **#3 Pipeline e-commerce (Shopify)** | 20–30 h | Medio | Bajo-medio: mucha validación, poca novedad | Último |

Las horas son estimaciones mías, no mediciones.

## #6 — Conversational Qualifier + Booking

Spec completa: `docs/specs/conversational-qualifier-booking.md`.

**Qué hace:** toma a un lead que respondió un SMS y lo lleva hasta una cita agendada sin intervención manual. Hace 3–5 preguntas de calificación, ofrece horarios reales del calendario de GHL, agenda y confirma. Escala a un humano solo cuando hace falta: confianza baja, lead molesto, pide un humano o 6 intentos sin resolver.

**Por qué es el mejor siguiente paso**
- Cierra el embudo con lo que ya existe: Intake capta, Revival reactiva, este convierte. La historia completa vale más que tres piezas sueltas.
- Reutiliza casi todo: detección de bajas sin IA, cola con horario por zona, Review Page para el handoff, Error Handler y reporte semanal.
- Es de lo más pedido por clientes de GHL: un agente conversacional que agenda.
- Mantiene los principios del portafolio: la IA solo decide la intención y redacta; validación, compuertas y envío son código determinístico.

**Puntos fuertes de la spec:** idempotencia por `message_id`, opt-out antes de la IA, schema JSON de salida, validación determinística (sin links, sin precios, máximo 320 caracteres), compuerta de confianza, 10 casos de prueba y una definición de terminado clara.

**Detalles a resolver antes de construir**
1. **Carrera entre mensajes:** si el lead manda dos mensajes seguidos, dos ejecuciones leen el mismo `conversation_state`. Hace falta un bloqueo por contacto (por ejemplo `SELECT … FOR UPDATE` o una clave de idempotencia por contacto y paso).
2. **Selección de slot:** la spec deja que Claude mapee el texto al slot. En código hay que validar que el `slot_id` devuelto esté en `offered_slots`; si no, repreguntar.
3. **Zona horaria:** reutilizar `lib/schedule.js`, que ya infiere la zona del contacto. Los slots se muestran en la zona del lead.
4. **Handoff:** la Review Page actual está pensada para lotes de Revival. Habrá que adaptarla a una conversación individual.
5. **GHL real sin verificar:** Conversations API, Calendars API (slots y creación de cita) y el webhook entrante no se han probado con credenciales. Se construye en `mock` y se declara como contrato supuesto hasta tener una sub-cuenta de prueba.
6. **Estimación:** 15–20 h es razonable para el camino feliz. Con los casos de inyección, carrera y conflicto de slot, yo contaría 20–25 h.

**Confianza:** alta en el valor y el reúso; media en las horas.

## #4 — Soporte con tickets y RAG

**Qué hace:** recibe un ticket (email o webhook), clasifica intención y sentimiento, busca la respuesta en una base de conocimiento (RAG con pgvector) y redacta una respuesta que cita su fuente. Si la confianza es baja, el caso es sensible o el cliente está molesto, lo escala a un humano.

**Qué tan bueno es:** es el patrón de agente IA más pedido del mercado y demuestra algo que aún no tenemos: recuperación con evidencia citada. Encaja con tu enfoque de trazabilidad de evidencia.

**Detalles y riesgos**
- La imagen de Postgres necesita la extensión `pgvector` (cambio en `docker-compose.yml`).
- Hay que decidir embeddings (proveedor y costo) y cómo simularlos de forma determinística en modo `mock`.
- Sin un conjunto de preguntas de prueba con respuesta esperada no se puede afirmar que "funciona". Habría que construir esa evaluación.
- Reglas determinísticas: nunca responder con datos de otro cliente, nunca prometer reembolsos ni plazos, y escalar siempre en casos legales o de seguridad.

**Confianza:** media; depende de cómo se mida la calidad de recuperación.

## #2 — Intake legal (Clio)

**Qué hace:** recibe la consulta de un posible cliente de un despacho y extrae los datos del caso (tipo, partes, fechas, urgencia) con citas textuales. Revisa conflicto de interés contra una lista de clientes y partes contrarias, y crea el asunto (matter) en Clio tras la aprobación de un abogado.

**Qué tan bueno es:** buen ejemplo de alto riesgo con supervisión humana obligatoria, que es justo tu diferenciador. Es un nicho: sirve si apuntas a despachos y menos como pieza general.

**Detalles y riesgos**
- Datos sensibles: solo sintéticos, y dejar claro qué se guarda y por cuánto tiempo.
- El conflicto de interés debe ser una coincidencia determinística con nombres normalizados. La IA solo extrae; nunca decide.
- La API de Clio no está verificada; se haría en `mock`.
- No debe dar asesoría legal al consultante: validar que el mensaje saliente no la dé.

**Confianza:** media; el valor depende del mercado objetivo.

## #3 — Pipeline e-commerce (Shopify)

**Qué hace:** toma productos de una hoja o proveedor, valida SKU, variantes y precios, genera la descripción con la voz de la marca, la deja en una hoja de revisión y, tras aprobación, publica en Shopify.

**Qué tan bueno es:** útil y vendible, pero repite patrones ya demostrados (validación determinística, IA para texto, aprobación). Aporta poco nuevo al portafolio.

**Detalles y riesgos**
- Mucha lógica de validación de datos: variantes, precios, duplicados.
- La revisión en Google Sheets implica OAuth, que no se puede probar en local sin credenciales.
- Publicar en Shopify es una acción externa difícil de revertir: exigir aprobación y publicar primero como borrador.

**Confianza:** media-alta en la estimación; valor de portafolio más bajo.

## Pendientes transversales (no son automatizaciones nuevas)

| Pendiente | Por qué importa |
|---|---|
| Probar con credenciales reales (Claude, GHL) en una sub-cuenta de prueba | Hasta entonces todo está "construido y probado en mock" y los contratos de GHL no están verificados |
| Slack como canal de aprobación | Hoy es email (Mailpit); Slack es lo habitual en clientes |
| Métricas del flujo #6 en el reporte semanal y el dashboard | Muestra el embudo completo |
| Autenticación real en las llamadas internas (hoy token compartido en Config) | Necesario antes de cualquier uso fuera de local |
| Video demo de 60–90 s del embudo | Es lo que más convence a un cliente |

## Cómo presentarlo sin exagerar

- Decir "construido y probado con datos sintéticos en modo mock" hasta verificar con APIs reales.
- No afirmar resultados de clientes ni uso en producción.
- Un caso donde la IA falló y el sistema lo contuvo (inyección bloqueada, JSON inválido que escaló a humano) comunica más confianza que decir que todo salió bien.
