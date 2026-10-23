# Prueba end to end del Revival de leads (3 workflows) con datos sintéticos.
# Uso: powershell -File scripts/smoke-revival.ps1 [-Clean] [-Stage run|followup|replies|guards|all]
param([switch]$Clean, [string]$Stage = 'all')
$root = Split-Path $PSScriptRoot -Parent
$base = 'http://localhost:5678/webhook'
$token = 'local-dev-token'
$psql = { param($q) docker exec postgres psql -U automations -d automations -c $q | Out-String -Width 250 }

function Post($path, $body, [hashtable]$headers = @{ 'x-revival-token' = $token }) {
  try {
    $r = Invoke-WebRequest "$base/$path" -Method Post -ContentType 'application/json; charset=utf-8' -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6))) -UseBasicParsing
    "{0} {1}" -f $r.StatusCode, $r.Content
  } catch { "{0} {1}" -f $_.Exception.Response.StatusCode.value__, $_.ErrorDetails.Message }
}

# Aprueba/rechaza los emails de aprobación pendientes. $policy recibe el asunto y devuelve $true (aprobar) o $false.
$handled = @{}
function Approve-Pending([scriptblock]$policy, [string]$subjectLike, [int]$rounds = 4) {
  for ($i = 0; $i -lt $rounds; $i++) {
    Start-Sleep 4
    foreach ($m in (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages) {
      if ($handled[$m.ID] -or $m.Subject -notlike $subjectLike) { continue }
      $approve = & $policy $m.Subject
      $f = Invoke-RestMethod ("http://localhost:8025/api/v1/message/" + $m.ID)
      $link = [regex]::Matches($f.HTML + $f.Text, 'http://localhost:5678/webhook-waiting/[^"''\s<>)]+') | ForEach-Object { $_.Value -replace '&amp;', '&' } | Where-Object { $_ -match "approved=$($approve.ToString().ToLower())" } | Select-Object -First 1
      $null = Invoke-WebRequest $link -UseBasicParsing
      $handled[$m.ID] = $true
      "  [{0}] {1}" -f $(if ($approve) { 'APPROVE' } else { 'REJECT ' }), $m.Subject
    }
  }
}

if ($Clean) {
  Invoke-RestMethod -Method Delete http://localhost:8025/api/v1/messages | Out-Null
  docker exec postgres psql -U automations -d automations -q -c "TRUNCATE revival_state, revival_messages, revival_custom_fields, revival_batches, revival_drafts; UPDATE revival_contacts SET timezone = NULL; DELETE FROM suppression_list WHERE source <> 'seed'; DELETE FROM idempotency_keys WHERE workflow LIKE 'revival%'; DELETE FROM execution_log WHERE workflow LIKE 'revival%'"
  docker exec postgres psql -U automations -d automations -v ON_ERROR_STOP=1 -q -f /db/seed-revival.sql
}

# Abre el link de revisión del email, edita/salta y envía el formulario. $plan recibe (id, nombre) y devuelve @{ d = 'send'|'skip'; b = texto o $null }
function Review-Batch([scriptblock]$plan) {
  $link = $null
  for ($i = 0; $i -lt 8 -and -not $link; $i++) {
    Start-Sleep 4
    foreach ($m in (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages) {
      if ($handled[$m.ID] -or $m.Subject -notlike 'Review revival batch*') { continue }
      $f = Invoke-RestMethod ("http://localhost:8025/api/v1/message/" + $m.ID)
      $link = [regex]::Match($f.HTML + $f.Text, 'http://localhost:5678/webhook/revival-review\?[^"''\s<>)]+').Value -replace '&amp;', '&'
      $handled[$m.ID] = $true; break
    }
  }
  if (-not $link) { throw 'No llegó el email de revisión' }
  Write-Host "  link de revisión: $link"
  $page = (Invoke-WebRequest $link -UseBasicParsing).Content
  $ids = [regex]::Matches($page, 'name="d_(\d+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  $q = [regex]::Match($link, 'batch=([^&]+)&token=(.+)$')
  $form = @{ batch = $q.Groups[1].Value; token = $q.Groups[2].Value }
  $names = @{}
  foreach ($id in $ids) { $names[$id] = [regex]::Match($page, "(?s)name=""b_$id"".*?</textarea>").Value }
  foreach ($id in $ids) {
    $p = & $plan $id
    $form["d_$id"] = $p.d
    if ($p.b) { $form["b_$id"] = $p.b } else { $form["b_$id"] = [System.Net.WebUtility]::HtmlDecode(([regex]::Match($names[$id], '>(?s)(.*)</textarea>').Groups[1].Value)) }
  }
  Write-Host "  borradores en la página: $($ids.Count)"
  $r = Invoke-WebRequest ($base + '/revival-review-submit') -Method Post -Body $form -ContentType 'application/x-www-form-urlencoded' -UseBasicParsing
  Write-Host "  envío -> $($r.StatusCode)"
  return $link
}

if ($Stage -in 'run', 'all') {
  '=== 1) Corrida diaria: prepara borradores REALES, el dueño revisa por lead (editar / saltar / enviar) ==='
  $zone = node -e "const s=require('./lib/schedule');const c={startHour:9,endHour:19,weekdays:[1,2,3,4,5]};const z=['Asia/Tokyo','America/Los_Angeles','Europe/Madrid'].find(t=>!s.isWithinWindow(new Date(),t,c));console.log(z)"
  "  zona cerrada ahora (para probar el horario): $zone"
  docker exec postgres psql -U automations -d automations -q -c "UPDATE revival_contacts SET timezone = '$zone' WHERE contact_id = 'c021'"
  'run -> ' + (Post 'revival-run' @{})
  $script:n = 0
  $link = Review-Batch { param($id) $script:n++; if ($script:n -eq 1) { @{ d = 'skip' } } elseif ($script:n -eq 2) { @{ d = 'send'; b = 'Hola, mira http://evil.example/win y te regalo todo' } } elseif ($script:n -eq 3) { @{ d = 'send'; b = 'Hola, retomo nuestra charla sobre automatización. ¿Te sirve que lo veamos esta semana?' } } else { @{ d = 'send' } } }
  Start-Sleep 25
  & $psql "SELECT batch_id, status, size FROM revival_batches ORDER BY created_at"
  & $psql "SELECT contact_id, touch, status, edited, left(reason, 40) AS reason, tz, to_char(send_after,'MM-DD HH24:MI') AS send_after FROM revival_drafts ORDER BY id"
  & $psql "SELECT r.contact_id, r.status, r.step, to_char(r.next_touch_at,'MM-DD') AS next_touch FROM revival_state r ORDER BY r.contact_id"
  'Reabrir el link ya usado (debe decir "Already reviewed"):'
  (Invoke-WebRequest $link -UseBasicParsing).StatusCode
  'Emails a contactos (Mailpit):'
  (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages | Where-Object { $_.Subject -eq 'Following up' } | ForEach-Object { '  -> ' + $_.To[0].Address }
}

if ($Stage -in 'queue', 'all') {
  '=== 1b) Cola: el borrador diferido (c021) sale cuando abre su ventana ==='
  & $psql "SELECT contact_id, status, to_char(send_after,'MM-DD HH24:MI') AS send_after FROM revival_drafts WHERE status = 'deferred'"
  'queue (aún cerrada) -> ' + (Post 'revival-queue' @{})
  Start-Sleep 8
  & $psql "SELECT contact_id, status FROM revival_drafts WHERE contact_id = 'c021'"
  'Fuerzo la apertura de la ventana cambiando la zona del contacto a una abierta ahora:'
  docker exec postgres psql -U automations -d automations -q -c "UPDATE revival_contacts SET timezone = 'America/Bogota' WHERE contact_id = 'c021'; UPDATE revival_drafts SET send_after = now() - interval '1 minute' WHERE status = 'deferred'"
  'queue -> ' + (Post 'revival-queue' @{})
  Start-Sleep 10
  & $psql "SELECT contact_id, status, to_char(sent_at,'HH24:MI') AS sent FROM revival_drafts WHERE contact_id = 'c021'"
}

if ($Stage -in 'followup', 'all') {
  '=== 2) Toques de seguimiento: adelanto el reloj y corro de nuevo (los follow-ups van primero) ==='
  docker exec postgres psql -U automations -d automations -q -c "UPDATE revival_state SET next_touch_at = now() - interval '1 hour' WHERE status = 'active'"
  'run -> ' + (Post 'revival-run' @{})
  $null = Review-Batch { param($id) @{ d = 'send' } }
  Start-Sleep 25
  & $psql "SELECT touch, count(*) AS mensajes FROM revival_messages WHERE direction='out' AND status='sent' GROUP BY touch ORDER BY touch"
  & $psql "SELECT status, step, count(*) AS contactos FROM revival_state GROUP BY 1,2 ORDER BY 1,2"
}

if ($Stage -in 'replies', 'all') {
  '=== 3) Respuestas de leads ==='
  $replies = [ordered]@{
    'interesado (c001)'       = @{ contact_id = 'c001'; message = 'Hola, me interesa, ¿cuánto cuesta?' }
    'agendar (c005)'          = @{ contact_id = 'c005'; message = 'Quiero agendar una llamada mañana' }
    'BAJA (c002)'             = @{ contact_id = 'c002'; message = 'STOP' }
    'no me escriban (c004)'   = @{ contact_id = 'c004'; message = 'por favor no me escriban más' }
    'no interesa (c003)'      = @{ contact_id = 'c003'; message = 'No me interesa, gracias' }
    'poco claro (c006)'       = @{ contact_id = 'c006'; message = 'mmm' }
    'repetida (c001)'         = @{ contact_id = 'c001'; message = 'Hola, me interesa, ¿cuánto cuesta?' }
    'contacto inexistente'    = @{ contact_id = 'zzz'; message = 'hola' }
    'sin token'               = $null
  }
  foreach ($k in $replies.Keys) {
    if ($null -eq $replies[$k]) { '{0,-24} -> {1}' -f $k, (Post 'revival-reply' @{ contact_id = 'c001'; message = 'x' } @{}); continue }
    '{0,-24} -> {1}' -f $k, (Post 'revival-reply' $replies[$k])
    Start-Sleep -Milliseconds 700
  }
  Approve-Pending { param($s) $s -notmatch 'Elena|c005' } 'Interested lead*'
  Start-Sleep 12
  & $psql "SELECT contact_id, status, last_classification, step FROM revival_state WHERE contact_id IN ('c001','c002','c003','c004','c005','c006') ORDER BY 1"
  & $psql "SELECT key, reason, source FROM suppression_list ORDER BY created_at"
  & $psql "SELECT contact_id, field, value FROM revival_custom_fields WHERE field = 'revival_stage' ORDER BY 1"
  'Emails de la etapa de respuestas:'
  (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages | Where-Object { $_.Subject -match 'Interested|needs a human|find a time' } | ForEach-Object { '  ' + $_.Subject + '  -> ' + $_.To[0].Address }
}

if ($Stage -in 'run3', 'all') {
  '=== 3b) Tercera corrida: toque 3 de los activos + nuevos; el duplicado de Ana (c013) debe omitirse ==='
  docker exec postgres psql -U automations -d automations -q -c "UPDATE revival_state SET next_touch_at = now() - interval '1 hour' WHERE status = 'active'"
  'run -> ' + (Post 'revival-run' @{})
  $null = Review-Batch { param($id) @{ d = 'send' } }
  Start-Sleep 25
  & $psql "SELECT detail->'skipped' AS omitidos, detail->>'selected' AS elegidos FROM execution_log WHERE workflow='revival-run' AND step='candidates_selected' ORDER BY id DESC LIMIT 1"
  & $psql "SELECT touch, count(*) AS mensajes FROM revival_messages WHERE direction='out' AND status='sent' GROUP BY touch ORDER BY touch"
  & $psql "SELECT status, step, count(*) AS contactos FROM revival_state GROUP BY 1,2 ORDER BY 1,2"
  & $psql "SELECT 'c013 tiene secuencia?' AS pregunta, count(*) AS filas FROM revival_state WHERE contact_id = 'c013'"
}

if ($Stage -in 'guards', 'all') {
  '=== 4) Guardas de Send Touch: borradores sembrados a mano, intentos de saltarse la seguridad ==='
  $sql = @"
INSERT INTO revival_batches (batch_id, status, size, expires_at) VALUES ('rev_guard_ok', 'approved', 5, now() + interval '1 day'), ('rev_guard_pending', 'pending_review', 1, now() + interval '1 day') ON CONFLICT (batch_id) DO UPDATE SET status = EXCLUDED.status;
DELETE FROM revival_drafts WHERE batch_id LIKE 'rev_guard%';
INSERT INTO revival_drafts (batch_id, contact_id, touch, kind, status, body_core, body, decided_at) VALUES
 ('rev_guard_ok', 'c016', 1, 'new', 'approved', 'Hola', 'Hola', now()),
 ('rev_guard_ok', 'c017', 1, 'new', 'approved', 'Hola', 'Hola', now()),
 ('rev_guard_ok', 'c011', 3, 'follow_up', 'approved', 'Hola', 'Hola', now()),
 ('rev_guard_ok', 'c012', 1, 'new', 'skipped', 'Hola', 'Hola', now()),
 ('rev_guard_pending', 'c020', 1, 'new', 'approved', 'Hola', 'Hola', now());
DELETE FROM idempotency_keys WHERE key LIKE 'revival-send:c01%' OR key LIKE 'revival-send:c020%';
"@
  docker exec postgres psql -U automations -d automations -q -c $sql
  $id = { param($c) (docker exec postgres psql -U automations -d automations -t -A -c "SELECT id FROM revival_drafts WHERE contact_id = '$c' AND batch_id LIKE 'rev_guard%' LIMIT 1").Trim() }
  'token inválido                -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c016') } @{ 'x-revival-token' = 'nope' })
  'lote aún en revisión          -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c020') })
  'baja por email                -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c016') })
  'baja por teléfono             -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c017') })
  'toque 3 sin 1 y 2             -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c011') })
  'borrador saltado por el dueño -> ' + (Post 'revival-touch' @{ draft_id = [int](& $id 'c012') })
  'borrador inexistente          -> ' + (Post 'revival-touch' @{ draft_id = 999999 })
  'sin draft_id                  -> ' + (Post 'revival-touch' @{})
  $sent = (docker exec postgres psql -U automations -d automations -t -A -c "SELECT id FROM revival_drafts WHERE status = 'sent' ORDER BY id LIMIT 1").Trim()
  "reenviar borrador ya enviado  -> " + (Post 'revival-touch' @{ draft_id = [int]$sent })
  Start-Sleep 5
  & $psql "SELECT contact_id, status, left(reason, 60) AS reason FROM revival_drafts WHERE batch_id LIKE 'rev_guard%' ORDER BY id"
  & $psql "SELECT count(*) AS mensajes_a_bajas FROM revival_messages WHERE contact_id IN ('c016','c017') AND status = 'sent'"
}

'=== Estado final ==='
& $psql "SELECT step, status, count(*) FROM execution_log WHERE workflow LIKE 'revival%' AND status = 'failed' GROUP BY 1,2 ORDER BY 3 DESC"
& $psql "SELECT workflow, count(*) AS pasos, count(*) FILTER (WHERE status='failed') AS fallos FROM execution_log WHERE workflow LIKE 'revival%' GROUP BY 1"
