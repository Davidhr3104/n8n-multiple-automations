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
  docker exec postgres psql -U automations -d automations -q -c "TRUNCATE revival_state, revival_messages, revival_custom_fields, revival_batches; DELETE FROM suppression_list WHERE source <> 'seed'; DELETE FROM idempotency_keys WHERE workflow LIKE 'revival%'; DELETE FROM execution_log WHERE workflow LIKE 'revival%'"
  docker exec postgres psql -U automations -d automations -v ON_ERROR_STOP=1 -q -f /db/seed-revival.sql
}

if ($Stage -in 'run', 'all') {
  '=== 1) Corrida diaria (manual): selecciona, pide aprobación del LOTE y despacha ==='
  'run -> ' + (Post 'revival-run' @{})
  Approve-Pending { $true } 'Approve revival batch*'
  Start-Sleep 25
  & $psql "SELECT batch_id, status, size, summary->>'accepted' AS accepted, summary->>'blocked' AS blocked FROM revival_batches ORDER BY created_at"
  & $psql "SELECT detail->'skipped' AS omitidos, detail->>'selected' AS elegidos FROM execution_log WHERE workflow='revival-run' AND step='candidates_selected' ORDER BY id DESC LIMIT 1"
  & $psql "SELECT r.contact_id, c.name, r.status, r.step, to_char(r.next_touch_at,'MM-DD') AS next_touch FROM revival_state r JOIN revival_contacts c USING (contact_id) ORDER BY r.contact_id"
  'Emails a contactos (Mailpit):'
  (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages | Where-Object { $_.Subject -eq 'Following up' } | ForEach-Object { '  -> ' + $_.To[0].Address }
}

if ($Stage -in 'followup', 'all') {
  '=== 2) Toques de seguimiento: adelanto el reloj y corro de nuevo (los follow-ups van primero) ==='
  docker exec postgres psql -U automations -d automations -q -c "UPDATE revival_state SET next_touch_at = now() - interval '1 hour' WHERE status = 'active'"
  'run -> ' + (Post 'revival-run' @{})
  Approve-Pending { $true } 'Approve revival batch*'
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
  Approve-Pending { $true } 'Approve revival batch*'
  Start-Sleep 25
  & $psql "SELECT detail->'skipped' AS omitidos, detail->>'selected' AS elegidos FROM execution_log WHERE workflow='revival-run' AND step='candidates_selected' ORDER BY id DESC LIMIT 1"
  & $psql "SELECT touch, count(*) AS mensajes FROM revival_messages WHERE direction='out' AND status='sent' GROUP BY touch ORDER BY touch"
  & $psql "SELECT status, step, count(*) AS contactos FROM revival_state GROUP BY 1,2 ORDER BY 1,2"
  & $psql "SELECT 'c013 tiene secuencia?' AS pregunta, count(*) AS filas FROM revival_state WHERE contact_id = 'c013'"
}

if ($Stage -in 'guards', 'all') {
  '=== 4) Guardas: intentos de saltarse la seguridad (lote de prueba aprobado + lote pendiente) ==='
  docker exec postgres psql -U automations -d automations -q -c "INSERT INTO revival_batches (batch_id, status, size) VALUES ('rev_guard_ok', 'approved', 9), ('rev_guard_pending', 'pending_approval', 1) ON CONFLICT (batch_id) DO UPDATE SET status = EXCLUDED.status"
  docker exec postgres psql -U automations -d automations -q -c "DELETE FROM idempotency_keys WHERE key LIKE 'revival-touch:c019%'"
  'token inválido            -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c007'; touch = 1 } @{ 'x-revival-token' = 'nope' })
  'lote NO aprobado          -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_pending'; contact_id = 'c007'; touch = 1 })
  'lista de bajas (email)    -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c016'; touch = 1 })
  'lista de bajas (teléfono) -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c017'; touch = 1 })
  'opted_out por baja (c002) -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c002'; touch = 3 })
  'toque 3 sin 1 y 2 (c011)  -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c011'; touch = 3 })
  'repetir toque 1 (c021)    -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c021'; touch = 1 })
  $act = (docker exec postgres psql -U automations -d automations -t -A -c "SELECT contact_id FROM revival_state WHERE status = 'active' AND step = 1 LIMIT 1").Trim()
  "concurrente $act toque 2 #1 -> " + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = $act; touch = 2 })
  "concurrente $act toque 2 #2 -> " + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = $act; touch = 2 })
  'historial con inyección c019 -> ' + (Post 'revival-touch' @{ batch_id = 'rev_guard_ok'; contact_id = 'c019'; touch = 1 })
  Start-Sleep 8
  & $psql "SELECT contact_id, touch, status, left(body, 110) AS body FROM revival_messages WHERE status = 'blocked' AND batch_id = 'rev_guard_ok' OR (status = 'blocked' AND body LIKE '[BLOCKED%') ORDER BY id"
  & $psql "SELECT status FROM revival_state WHERE contact_id = 'c019'"
  "Mensajes enviados con toque 2 a $act (debe ser exactamente 1):"
  & $psql "SELECT count(*) AS toque2_enviados FROM revival_messages WHERE contact_id = '$act' AND touch = 2 AND status = 'sent'"
  'Alerta por mensaje bloqueado:'
  (Invoke-RestMethod http://localhost:8025/api/v1/messages).messages | Where-Object { $_.Subject -match 'ERROR' } | Select-Object -First 3 | ForEach-Object { '  ' + $_.Subject }
}

'=== Estado final ==='
& $psql "SELECT step, status, count(*) FROM execution_log WHERE workflow LIKE 'revival%' AND status = 'failed' GROUP BY 1,2 ORDER BY 3 DESC"
& $psql "SELECT workflow, count(*) AS pasos, count(*) FILTER (WHERE status='failed') AS fallos FROM execution_log WHERE workflow LIKE 'revival%' GROUP BY 1"
