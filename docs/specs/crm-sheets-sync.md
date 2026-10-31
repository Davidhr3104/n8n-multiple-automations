# CRM ↔ Sheets Sync con dedupe

> Estado 2026-10-30: **construido y probado en mock** (19 pruebas unitarias + `scripts/smoke-sync.ps1` 40/40). Adaptadores live NO construidos. Cambios respecto al plan: sin clave de idempotencia por ventana (el plan converge y un bloqueo con vencimiento evita corridas solapadas); cada escritura lleva guarda de carrera (`updated_at`) y la sentencia se aborta entera si no cuadra.

Objetivo: un solo dato correcto en el CRM y en la hoja de cálculo, con historial de cada cambio. Sin IA: es 100 % determinístico a propósito
(la regla "la IA solo donde hace falta juicio" también significa no ponerla donde un algoritmo basta). Los casos dudosos van a una persona.

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Adaptadores | En local, tablas de Postgres hacen de CRM (`sync_crm_contacts`) y de hoja (`sync_sheet_rows`). Los nodos "Read/Write" son la frontera del adaptador | No hay Google Sheets ni GHL reales en local. **Los adaptadores live NO están construidos**: con `SYNC_MODE=live` el flujo falla ruidosamente, nunca cae a mock en silencio |
| Qué es un duplicado | Mismo email normalizado, o mismo teléfono normalizado **y** nombre parecido (≥ 0,5 de similitud de palabras) | Mismo teléfono con nombres distintos puede ser una familia o una recepción: se marca para revisión, NO se fusiona |
| Borrados | Nunca se propagan ni se borra nada. Un duplicado se marca (`merged_into` / `duplicate_of`), no se elimina | Un borrado erróneo en un sistema no puede arrastrar al otro |
| Cambios | Fusión de tres vías con el último valor sincronizado (`base`): si solo cambió un lado, gana ese; si cambiaron los dos con valores distintos, es un **conflicto** y no se toca ninguno | Última escritura gana pierde datos en silencio |
| Datos sin email ni teléfono | Se reportan como inválidos; no se crean en el CRM | No se pueden deduplicar |
| Idempotencia | El resultado depende de los vínculos y sus `base`: una segunda corrida sin cambios no escribe nada. Las corridas programadas usan una clave por ventana de 10 min | Evita doble ejecución si el cron se solapa |

## Flujo (`Sync · Run`, cada 15 min o por webhook)
1. Leer ambos lados + vínculos (adaptadores).
2. Normalizar (email en minúsculas, teléfono E.164, espacios) y **planificar** (código puro con pruebas): vínculos, duplicados, creaciones, actualizaciones, conflictos, inválidos.
3. Aplicar el plan en **una sola sentencia atómica** + registro de cada cambio (`sync_changes`).
4. Si hay conflictos, posibles duplicados o inválidos: email resumen con el link de revisión.
5. Log por paso, idempotencia, errores visibles.

## Revisión de conflictos (`Sync · Conflict Review`)
Página con cada conflicto (valor del CRM, valor de la hoja, último valor sincronizado) → elegir CRM, Hoja o dejar pendiente. Aplicar escribe el valor elegido en los DOS lados y actualiza el `base`.

## Resumen semanal (`Sync · Weekly Summary`)
Cifras por SQL (sin IA): vínculos, creaciones, actualizaciones, duplicados marcados, conflictos abiertos/resueltos, inválidos.

## Pruebas
`scripts/smoke-sync.ps1`: duplicados dentro de un lado, coincidencias con formatos distintos, teléfono compartido con nombres distintos (no se fusiona), propagación en ambos sentidos, conflicto cuando cambian los dos, resolución, borrado en un lado (no se propaga), datos inválidos, segunda corrida sin escrituras.

## Fuera de alcance
Adaptadores live (GHL y Google Sheets), campos personalizados, historial de actividad.
