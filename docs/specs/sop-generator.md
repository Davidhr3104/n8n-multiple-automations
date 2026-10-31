# SOP Generator — plan

Objetivo: convertir la explicación de un proceso (transcripción de una llamada, notas, un mensaje largo) en un procedimiento operativo (SOP) versionado, revisado por su responsable y publicado en una página. **La IA solo extrae los pasos que el texto dice, cada uno con su cita. El documento lo arma una plantilla y nada se publica sin que el responsable lo apruebe.**

## Decisiones (y por qué)

| Decisión | Elección | Motivo / riesgo |
|---|---|---|
| Datos sensibles | Antes de la IA y antes de guardar, el código tapa contraseñas, claves de API y tarjetas (Luhn) y lo declara | Una transcripción real suele traer credenciales dichas en voz alta; no deben acabar en un SOP |
| IA | Extrae pasos (`record_sop`): texto, quién, tipo (acción / decisión / control) y la cita textual | La IA no inventa pasos: el código descarta los que no están en el texto |
| Calidad | Código: mínimo de pasos, pasos sin responsable, proporción de pasos descartados, pasos duplicados | Un SOP flojo no se manda a aprobar: queda `needs_input` y se le dice al autor qué falta |
| Documento | Plantilla fija (propósito, responsables, pasos numerados, puntos de decisión, huecos detectados, procedencia) | Mismo formato siempre; cada paso lleva su cita |
| Publicación | Siempre la aprueba el responsable (email enviar-y-esperar, 48 h). Sin respuesta o ambiguo = no se publica | Publicar un procedimiento equivocado afecta a todo el equipo |
| Versiones | Cada borrador es una versión nueva; al aprobar, la anterior pasa a `superseded` en la misma sentencia. Si ya se publicó una versión más nueva, la vieja no se publica | Nunca dos versiones vigentes ni una vieja pisando una nueva |
| Cambios | Se muestra qué pasos se añaden, quitan o cambian respecto a la versión vigente | El responsable aprueba una diferencia, no un documento entero |
| Revisión periódica | Barrido diario: pasados N días el responsable recibe un recordatorio; a los N + 14 se avisa a operaciones; un borrador pendiente de aprobación mucho tiempo también se recuerda | Un SOP caducado en silencio es peor que no tenerlo |
| Página pública | GET de solo lectura, todo escapado, solo muestra versiones publicadas | Un borrador nunca se ve desde fuera |
| Idempotencia | `sop_id` + md5 del texto fuente | El mismo texto reenviado no crea otra versión |
| Tiempo en pruebas | `now` solo con token y en mock | |

## Workflows

1. **sop-draft** (`POST /webhook/sop-draft`): valida, tapa datos sensibles, extrae pasos (IA lee), verifica citas, comprueba calidad, arma el documento, guarda la versión, pide aprobación y publica de forma atómica.
2. **sop-view** (`GET /webhook/sop-view?sop_id=&version=`): página HTML de la versión publicada.
3. **sop-sweep** (cron diario + `POST /webhook/sop-run`): recordatorios de revisión, escalamiento y borradores sin decidir.

## Fuera de alcance / sin verificar
- Notion / Drive / wiki reales: en local es una tabla y una página servida por n8n.
- Claude en vivo (herramienta `record_sop`).
- Transcripción de audio o vídeo (el sistema recibe el texto).
