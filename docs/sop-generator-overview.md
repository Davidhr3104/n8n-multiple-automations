# SOP Generator — resumen

Convierte la explicación de un proceso (transcripción o notas) en un procedimiento versionado. Plan y decisiones: `docs/specs/sop-generator.md`.

**Modo mock, datos sintéticos.** Wiki real (Notion / Docs / Confluence) y Claude en vivo: sin verificar.

## Cómo funciona
1. `sop-draft` (`POST /webhook/sop-draft`, cabecera `x-sop-token`): valida → tapa contraseñas, claves y tarjetas → extrae pasos (la IA solo lee, cada paso con su cita) → el código verifica las citas y la calidad → plantilla de documento → guarda la versión → el responsable aprueba por email → publicación atómica.
2. `sop-view` (`GET /webhook/sop-view?sop_id=&version=`): página de lectura de lo publicado.
3. `sop-sweep` (cron diario + `POST /webhook/sop-run`): recordatorio a los 90 días, escalamiento a operaciones 14 días después, recordatorio de borradores sin decidir.

## Qué decide el código y qué la IA
| La IA | El código |
|---|---|
| Lista los pasos que el texto describe, con su cita | Tapa secretos, bloquea inyección, verifica cada cita, calidad, plantilla del documento, diferencias entre versiones, regla de publicación, plazos de revisión |

## Probado (`scripts/smoke-sop.ps1`: 55 comprobaciones; `test/sop.test.js` + `test/soppages.test.js`: 15 tests)
Validación; camino feliz con aprobación y página; mismo texto = duplicado; secretos fuera del correo y de la base; inyección, IA caída y pocos pasos = `needs_input` con el motivo; huecos declarados; XSS escapado; versiones atómicas; aprobación tardía de una versión vieja no se publica; borrador invisible en la página; barrido de revisión sin repetir avisos.

## Límites
- La webhook de entrada guarda el payload en los datos de ejecución de n8n (puede traer secretos antes de taparlos): en producción, limitar el guardado de ejecuciones.
- El extractor local es una heurística de palabras: la calidad de la extracción no mide un modelo real.
- n8n aplica su propia CSP con sandbox a las páginas HTML; la página se apoya en escapar todo.
- Dos borradores simultáneos del mismo SOP compiten por el número de versión: el segundo falla de forma visible.
- Un procedimiento solo se reconfirma enviando una versión nueva.
