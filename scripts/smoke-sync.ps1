# Prueba end to end de CRM <-> Sheets Sync (adaptadores MOCK): vinculación, duplicados, tres vías, conflictos, revisión, borrados, bloqueo.
# Uso: powershell -File scripts/smoke-sync.ps1   (BORRA las tablas sync_* y el buzón de Mailpit: solo datos de prueba)
$base = 'http://localhost:5678/webhook'
$token = 'local-dev-token'
$script:pass = 0; $script:fail = 0
function Check($name, $ok, $detail = '') { if ($ok) { $script:pass++; "  PASS  $name" } else { $script:fail++; "  FAIL  $name   $detail" } }
function Sql($sql) { ($sql | docker exec -i postgres psql -U automations -d automations -t -A -v ON_ERROR_STOP=1 | Out-String).Trim() }
function Run-Sync {
  try { $r = Invoke-WebRequest "$base/sync-run" -Method Post -Headers @{ 'x-sync-token' = $token } -UseBasicParsing -TimeoutSec 120; $j = $r.Content | ConvertFrom-Json; if ($j -is [array]) { $j = $j[0] }; return $j }
  catch { return [pscustomobject]@{ status = 'http_error'; error = "$($_.Exception.Message) $($_.ErrorDetails.Message)" } }
}
function Mails($pattern) { @((Invoke-RestMethod http://localhost:8025/api/v1/messages?limit=200).messages | Where-Object { $_.Subject -like $pattern }) }
function Http($method, $url, $form = $null) {
  try { $p = @{ Uri = $url; Method = $method; UseBasicParsing = $true }; if ($form) { $p.Body = $form; $p.ContentType = 'application/x-www-form-urlencoded' }; $r = Invoke-WebRequest @p; return @{ code = $r.StatusCode; body = $r.Content } }
  catch { return @{ code = $_.Exception.Response.StatusCode.value__; body = "$($_.ErrorDetails.Message)" } }
}

if ((Sql 'SELECT 1') -ne '1') { throw 'Postgres no responde' }
Sql 'TRUNCATE sync_crm_contacts, sync_sheet_rows, sync_links, sync_conflicts, sync_issues, sync_changes, sync_reviews RESTART IDENTITY; DELETE FROM idempotency_keys WHERE key = ''sync-lock''' | Out-Null
Invoke-RestMethod -Method Delete http://localhost:8025/api/v1/messages | Out-Null

'=== 1) Entrada inválida y bloqueo ==='
try { $r = Invoke-WebRequest "$base/sync-run" -Method Post -UseBasicParsing; $j = ($r.Content | ConvertFrom-Json); if ($j -is [array]) { $j = $j[0] } } catch { $j = [pscustomobject]@{ status = 'http_error' } }
Check 'sin token -> rejected' ($j.status -eq 'rejected') ($j | ConvertTo-Json -Compress)

'=== 2) Primera corrida: vincular, crear, duplicados, inválidos ==='
Sql @"
INSERT INTO sync_crm_contacts (id, name, email, phone, company, stage) VALUES
 ('c1', 'Ana Perez', 'ana@demo.co', '300 111 2222', 'Acme', 'New'),
 ('c2', 'Beto Ruiz', 'beto@demo.co', '300 222 3333', 'Beta SA', 'Lead'),
 ('c3', 'Carla Mora', 'CARLA@demo.co', '', 'Gamma', 'Lead'),
 ('c3b', 'Carla M.', 'carla@demo.co', '', '', ''),
 ('c4', 'Sin Datos', '', '123', '', ''),
 ('c5', 'Luis Gomez', '', '300 555 0000', '', '');
INSERT INTO sync_sheet_rows (id, name, email, phone, company, stage) VALUES
 ('r1', 'ana perez', 'ANA@DEMO.CO', '', '', 'new'),
 ('r2', 'Diego Paz', 'diego@demo.co', '', 'Delta', 'Lead'),
 ('r5', 'Recepcion Clinica', '', '3005550000', '', '');
"@ | Out-Null
$r = Run-Sync
Check 'corrida ok' ($r.status -eq 'ok') ($r | ConvertTo-Json -Compress)
Check 'crea en la hoja: Beto y Carla (no el inválido ni el retenido)' (([int]$r.applied.created_sheet) -eq 2) ($r | ConvertTo-Json -Compress -Depth 5)
Check 'crea en el CRM: Diego' (([int]$r.applied.created_crm) -eq 1)
Check 'vincula 4 pares (1 por email + 3 creados)' (([int]$r.applied.new_links) -eq 4)
Check 'duplicado del CRM marcado (c3b -> c3), NO borrado' ((Sql "SELECT merged_into FROM sync_crm_contacts WHERE id = 'c3b'") -eq 'c3')
Check 'el duplicado sigue existiendo (nada se borra)' ((Sql 'SELECT count(*) FROM sync_crm_contacts WHERE id = ''c3b''') -eq '1')
Check 'campos vacíos se rellenan con el otro lado y se normalizan (teléfono E.164, empresa)' ((Sql "SELECT phone || '|' || company FROM sync_sheet_rows WHERE id = 'r1'") -eq '+573001112222|Acme')
Check 'sin conflicto en la vinculación de Ana' ((Sql 'SELECT count(*) FROM sync_conflicts') -eq '0')
Check 'inválido NO se crea en la hoja' ((Sql "SELECT count(*) FROM sync_sheet_rows WHERE id LIKE '%c4%'") -eq '0')
Check 'mismo teléfono con nombres distintos: retenido, sin crear ni vincular' (((Sql "SELECT count(*) FROM sync_sheet_rows WHERE id LIKE 'row-from-c5%'") -eq '0') -and ((Sql "SELECT count(*) FROM sync_links WHERE crm_id = 'c5' OR sheet_id = 'r5'") -eq '0'))
Check 'incidencias registradas: inválido + posible duplicado' ((Sql "SELECT count(*) FROM sync_issues WHERE resolved_at IS NULL AND kind IN ('invalid_record','possible_duplicate')") -eq '2')
Check 'todo cambio quedó en el historial' ((Sql "SELECT count(*) FROM sync_changes WHERE run_id = '$($r.run_id)'") -ge '6')
Check 'se avisó a una persona (incidencias nuevas)' (@(Mails 'Sync needs a look*').Count -eq 1)

'=== 3) Segunda corrida sin cambios: cero escrituras, cero avisos ==='
$r = Run-Sync
$a = $r.applied
Check 'cero escrituras' (([int]$a.created_crm + [int]$a.created_sheet + [int]$a.updated_crm + [int]$a.updated_sheet + [int]$a.duplicates_marked + [int]$a.new_links + [int]$a.base_updates + [int]$a.changes_logged) -eq 0) ($r | ConvertTo-Json -Compress -Depth 5)
Check 'no repite el aviso de lo ya notificado' ((@(Mails 'Sync needs a look*').Count -eq 1) -and ($r.notified -eq $false))

'=== 4) Cambios en lados distintos se propagan en ambos sentidos ==='
Sql "UPDATE sync_crm_contacts SET stage = 'Won', updated_at = now() WHERE id = 'c1'; UPDATE sync_sheet_rows SET company = 'Acme Corp', updated_at = now() WHERE id = 'r1'" | Out-Null
$r = Run-Sync
Check 'etapa del CRM llegó a la hoja' ((Sql "SELECT stage FROM sync_sheet_rows WHERE id = 'r1'") -eq 'Won')
Check 'empresa de la hoja llegó al CRM' ((Sql "SELECT company FROM sync_crm_contacts WHERE id = 'c1'") -eq 'Acme Corp')
Check 'ni conflicto ni aviso' (([int]$r.applied.conflicts_open -eq 0) -and ($r.notified -eq $false))

'=== 5) Los dos lados cambian el mismo campo: conflicto, no se toca ninguno ==='
Sql "UPDATE sync_crm_contacts SET company = 'Beta <b>SAS</b>', stage = 'Lost', updated_at = now() WHERE id = 'c2'; UPDATE sync_sheet_rows SET company = 'Beta LLC', stage = 'Won', updated_at = now() WHERE id = 'row-from-c2'" | Out-Null
$r = Run-Sync
Check '2 conflictos abiertos' ((Sql "SELECT count(*) FROM sync_conflicts WHERE status = 'open'") -eq '2')
Check 'ningún lado fue modificado' (((Sql "SELECT company FROM sync_crm_contacts WHERE id = 'c2'") -eq 'Beta <b>SAS</b>') -and ((Sql "SELECT company FROM sync_sheet_rows WHERE id = 'row-from-c2'") -eq 'Beta LLC'))
$mails = @(Mails 'Sync needs a look*')
Check 'aviso con link de revisión' ($mails.Count -eq 2 -and $r.review_link -like 'http://localhost:5678/webhook/sync-review?review=*')
$r2 = Run-Sync
Check 'el mismo conflicto no se vuelve a notificar ni se duplica' (((Sql "SELECT count(*) FROM sync_conflicts WHERE status = 'open'") -eq '2') -and (@(Mails 'Sync needs a look*').Count -eq 2))

'=== 6) Página de revisión ==='
$page = Http 'GET' $r.review_link
Check 'la página muestra ambos valores' (($page.code -eq 200) -and ($page.body -match 'Beta LLC'))
Check 'el valor del CRM sale ESCAPADO (sin HTML crudo)' (($page.body -match 'Beta &lt;b&gt;SAS&lt;/b&gt;') -and ($page.body -notmatch 'Beta <b>SAS</b>'))
$bad = Http 'GET' ($r.review_link -replace 'token=[^&]+', 'token=nope')
Check 'token inválido -> 403 y no muestra datos' (($bad.code -eq 403) -and ($bad.body -notmatch 'Beta LLC'))
$rv = $r.review_link -replace '.*review=([^&]+)&token=(.+)', '$1|$2'
$rvId, $rvTok = $rv -split '\|'
$cCompany = Sql "SELECT id FROM sync_conflicts WHERE field = 'company' AND status = 'open'"
$cStage = Sql "SELECT id FROM sync_conflicts WHERE field = 'stage' AND status = 'open'"
$badPost = Http 'POST' "$base/sync-review-submit" @{ review = $rvId; token = 'wrong'; "c_$cCompany" = 'crm' }
Check 'enviar con token falso no cambia nada' (($badPost.code -eq 403) -and ((Sql "SELECT count(*) FROM sync_conflicts WHERE status = 'open'") -eq '2'))

'=== 7) Resolver: CRM gana en empresa, etapa queda pendiente ==='
$ok = Http 'POST' "$base/sync-review-submit" @{ review = $rvId; token = $rvTok; "c_$cCompany" = 'crm'; "c_$cStage" = 'pending' }
Check 'envío aceptado' ($ok.code -eq 200) $ok.body
Check 'el valor elegido se copió a la hoja' ((Sql "SELECT company FROM sync_sheet_rows WHERE id = 'row-from-c2'") -eq 'Beta <b>SAS</b>')
Check 'conflicto resuelto y el pendiente sigue abierto' (((Sql "SELECT status FROM sync_conflicts WHERE id = $cCompany") -eq 'resolved') -and ((Sql "SELECT status FROM sync_conflicts WHERE id = $cStage") -eq 'open'))
Check 'la resolución quedó en el historial' ((Sql "SELECT count(*) FROM sync_changes WHERE action = 'resolve_conflict'") -eq '1')
$r3 = Run-Sync
Check 'tras resolver, la siguiente corrida no escribe ni crea conflictos nuevos de la empresa' (([int]$r3.applied.updated_crm + [int]$r3.applied.updated_sheet -eq 0) -and ((Sql "SELECT count(*) FROM sync_conflicts WHERE field = 'company' AND status = 'open'") -eq '0'))

'=== 8) Guarda de carrera: una edición posterior invalida la elección ==='
Sql "UPDATE sync_sheet_rows SET name = 'Beto R. Ruiz', updated_at = now() WHERE id = 'row-from-c2'" | Out-Null
$stale = Http 'POST' "$base/sync-review-submit" @{ review = $rvId; token = $rvTok; "c_$cStage" = 'sheet' }
Check 'elección sobre registro cambiado: se omite y sigue abierto' (($stale.body -match 'skipped') -and ((Sql "SELECT status FROM sync_conflicts WHERE id = $cStage") -eq 'open'))
$null = Run-Sync
$cStage2 = Sql "SELECT id FROM sync_conflicts WHERE field = 'stage' AND status = 'open'"
$fresh = Http 'POST' "$base/sync-review-submit" @{ review = $rvId; token = $rvTok; "c_$cStage2" = 'sheet' }
Check 'tras re-evaluar con datos frescos, la elección sí se aplica' (((Sql "SELECT stage FROM sync_crm_contacts WHERE id = 'c2'") -eq 'Won') -and ((Sql "SELECT status FROM sync_conflicts WHERE id = $cStage2") -eq 'resolved')) $fresh.body

'=== 9) Borrados: no se propagan ni se recrean ==='
Sql "DELETE FROM sync_crm_contacts WHERE id = 'c1'" | Out-Null
$sheetBefore = Sql 'SELECT count(*) FROM sync_sheet_rows'
$r = Run-Sync
Check 'la fila de la hoja NO se borra' ((Sql "SELECT count(*) FROM sync_sheet_rows WHERE id = 'r1'") -eq '1')
Check 'no se recrea el contacto borrado en el CRM' (((Sql "SELECT count(*) FROM sync_crm_contacts WHERE email = 'ana@demo.co'") -eq '0') -and ((Sql 'SELECT count(*) FROM sync_sheet_rows') -eq $sheetBefore))
Check 'se reporta como vínculo huérfano' ((Sql "SELECT count(*) FROM sync_issues WHERE kind = 'orphan_link' AND resolved_at IS NULL") -eq '1')

'=== 10) Una sola corrida a la vez ==='
Sql "UPDATE idempotency_keys SET status = 'processing', claimed_at = now(), execution_id = 'otra' WHERE key = 'sync-lock'" | Out-Null
$busy = Run-Sync
Check 'con otra corrida en curso: busy, sin escribir' ($busy.status -eq 'busy')
Sql "UPDATE idempotency_keys SET status = 'done' WHERE key = 'sync-lock'" | Out-Null

'=== 11) Resumen semanal ==='
try { $w = Invoke-WebRequest "$base/sync-weekly" -Method Post -Headers @{ 'x-sync-token' = $token } -UseBasicParsing -TimeoutSec 60; $wj = $w.Content | ConvertFrom-Json; if ($wj -is [array]) { $wj = $wj[0] } } catch { $wj = [pscustomobject]@{ status = 'http_error' } }
Check 'resumen semanal enviado' (($wj.status -eq 'sent') -and (@(Mails 'Weekly CRM*').Count -eq 1)) ($wj | ConvertTo-Json -Compress)

'=== Estado final ==='
$unexpected = Sql "SELECT count(*) FROM execution_log WHERE workflow LIKE 'sync%' AND status = 'failed'"
Check 'ningún paso falló inesperadamente' ($unexpected -eq '0') "failed=$unexpected"
"RESULTADO: $($script:pass) PASS, $($script:fail) FAIL"
if ($script:fail -gt 0) { exit 1 }
