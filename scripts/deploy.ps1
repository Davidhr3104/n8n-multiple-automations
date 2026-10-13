# Reconstruye los workflows desde lib/ y build/, aplica el esquema SQL, importa, publica y reinicia n8n.
# Requiere: Docker corriendo y `docker compose up -d` ya ejecutado.
#   -WithCredentials  importa también los PLACEHOLDERS (Anthropic, GHL). Solo la primera vez:
#                     reimportarlos SOBRESCRIBE tus keys reales.
param([switch]$WithCredentials)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# Esquema (idempotente). Falla ruidosamente si el SQL es inválido.
docker exec postgres psql -U automations -d automations -v ON_ERROR_STOP=1 -q -f /docker-entrypoint-initdb.d/001-init.sql
if ($LASTEXITCODE -ne 0) { throw 'schema migration failed' }

docker exec n8n n8n import:credentials --input=/import/credentials/credentials-infra.json
if ($WithCredentials) { docker exec n8n n8n import:credentials --input=/import/credentials/credentials-placeholders.json }
docker exec n8n n8n import:workflow --separate --input=/import/workflows
foreach ($id in 'errhandler000001', 'leadintake000001') { docker exec n8n n8n publish:workflow --id=$id }

$since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
docker restart n8n | Out-Null
# healthz responde ANTES de que los webhooks estén registrados: esperamos a que n8n termine de cargar workflows publicados.
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 3
  if ((docker logs n8n --since $since 2>&1 | Out-String) -match 'Finished building workflow dependency index') { Start-Sleep 2; Write-Host 'n8n listo en http://localhost:5678'; return }
}
throw 'n8n no terminó de cargar los workflows tras reiniciar'
