param(
  [string]$SourceDatabaseUrl = $env:DATABASE_URL,
  [string]$TargetDatabase = 'finops_local',
  [int]$TargetPort = 5433,
  [string]$SnapshotDirectory = 'C:\FinOpsData\snapshots',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pgRoot = if ($env:FINOPS_POSTGRES_ROOT) { $env:FINOPS_POSTGRES_ROOT } else { 'C:\FinOpsData\postgres17' }
$bin = Join-Path $pgRoot 'pgsql\bin'
$pgDump = Join-Path $bin 'pg_dump.exe'
$pgRestore = Join-Path $bin 'pg_restore.exe'
$psql = Join-Path $bin 'psql.exe'
$localPasswordFile = Join-Path $pgRoot 'superuser.pass'

function Read-DotEnvValue([string]$name) {
  $envFile = Join-Path $repoRoot '.env'
  if (!(Test-Path $envFile)) { return $null }
  $line = Get-Content $envFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($null -eq $line) { return $null }
  return $line.Substring($name.Length + 1).Trim().Trim('"').Trim("'")
}

if ([string]::IsNullOrWhiteSpace($SourceDatabaseUrl)) {
  $SourceDatabaseUrl = Read-DotEnvValue 'DATABASE_URL'
}
if ([string]::IsNullOrWhiteSpace($SourceDatabaseUrl)) { throw 'Configura SourceDatabaseUrl o DATABASE_URL apuntando a Supabase.' }
if ($SourceDatabaseUrl -notmatch 'supabase\.co') { throw 'El origen debe ser Supabase; se rechazó el origen para evitar sobrescribir datos inesperados.' }
if (!(Test-Path $pgDump) -or !(Test-Path $pgRestore) -or !(Test-Path $psql)) { throw "No se encontraron las herramientas de PostgreSQL 17 en $bin." }
if (!(Test-Path $localPasswordFile)) { throw "No se encontró la contraseña local en $localPasswordFile." }
if (!$Force) { throw 'La clonación reemplaza la base local. Repite con -Force cuando hayas confirmado el destino.' }

& (Join-Path $PSScriptRoot 'start-postgres17.ps1')
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$snapshot = Join-Path $SnapshotDirectory $stamp
New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
$dump = Join-Path $snapshot 'finops-public-extensions.dump'
$dumpLog = Join-Path $snapshot 'pg_dump.log'
$restoreLog = Join-Path $snapshot 'pg_restore.log'

Write-Output 'Creando snapshot inmutable de public + extensiones necesarias...'
& $pgDump --dbname=$SourceDatabaseUrl --format=custom --no-owner --schema=extensions --schema=public --file=$dump --verbose 2> $dumpLog
if ($LASTEXITCODE -ne 0) { throw "pg_dump falló. Revisa $dumpLog." }

$env:PGPASSWORD = (Get-Content $localPasswordFile -Raw).Trim()
$localAdminArgs = @('-h', '127.0.0.1', '-p', "$TargetPort", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1')
$rolesSql = @'
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','finops_runtime','supabase_admin']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', role_name);
    END IF;
  END LOOP;
END $$;
GRANT finops_runtime TO postgres;
'@
& $psql @localAdminArgs -c $rolesSql
& $psql @localAdminArgs -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();" *> $null
& $psql @localAdminArgs -c "DROP DATABASE IF EXISTS \"$TargetDatabase\";"
& $psql @localAdminArgs -c "CREATE DATABASE \"$TargetDatabase\" OWNER postgres;"
$targetArgs = @('-h', '127.0.0.1', '-p', "$TargetPort", '-U', 'postgres', '-d', $TargetDatabase, '-v', 'ON_ERROR_STOP=1')
& $psql @targetArgs -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

Write-Output 'Restaurando aplicación FinOps en PostgreSQL local...'
& $pgRestore --dbname="postgresql://postgres@127.0.0.1:$TargetPort/$TargetDatabase" --schema=public --no-owner --no-privileges --role=postgres --exit-on-error -j 4 $dump 2> $restoreLog
if ($LASTEXITCODE -ne 0) { throw "pg_restore falló. Revisa $restoreLog." }

# El snapshot contiene el esquema en el momento de la extracción. Aplicar las
# migraciones pendientes hace que el clon sea reproducible incluso cuando el
# repositorio ya avanzó después de crear el dump.
$prismaCli = Join-Path $repoRoot 'node_modules\.bin\prisma.cmd'
if (!(Test-Path $prismaCli)) { throw "No se encontró Prisma CLI en $prismaCli. Ejecuta npm install antes de clonar." }
$encodedLocalPassword = [Uri]::EscapeDataString((Get-Content $localPasswordFile -Raw).Trim())
$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = "postgresql://postgres:$encodedLocalPassword@127.0.0.1:$TargetPort/$TargetDatabase"
  Push-Location $repoRoot
  try {
    & $prismaCli migrate deploy --schema (Join-Path $repoRoot 'prisma\schema.prisma')
    if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy falló sobre el clon local.' }
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
  else { $env:DATABASE_URL = $previousDatabaseUrl }
}

$grantsSql = @'
GRANT USAGE ON SCHEMA public TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO finops_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finops_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO finops_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finops_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO finops_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO finops_runtime;
'@
& $psql @targetArgs -c $grantsSql

# El snapshot conserva todo el historial; el clon operativo no debe reanudar leases heredados.
$queueSql = @'
UPDATE public.ingestion_jobs
SET status = 'CANCELLED'::"IngestionJobStatus",
    error_message = 'Imported Supabase queue reset before local workers start.',
    completed_at = COALESCE(completed_at, now()),
    updated_at = now(), locked_at = NULL, locked_by = NULL,
    archived_at = COALESCE(archived_at, now()),
    result_summary = COALESCE(result_summary, '{}'::jsonb)
      || jsonb_build_object('localClone', jsonb_build_object('queueReset', true, 'resetAt', now()))
WHERE status IN ('PENDING'::"IngestionJobStatus", 'RUNNING'::"IngestionJobStatus");
'@
& $psql @targetArgs -c $queueSql

$counts = & $psql @targetArgs -At -F '|' -c "SELECT (SELECT count(*) FROM tenants),(SELECT count(*) FROM cloud_connections),(SELECT count(*) FROM resource_metric_samples),(SELECT count(*) FROM focus_cost_line_items),(SELECT count(*) FROM ingestion_jobs WHERE status='CANCELLED');"
$hash = (Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash
$manifest = [ordered]@{
  project = 'finops-back'; createdAt = (Get-Date).ToUniversalTime().ToString('o')
  source = 'Supabase'; sourceScope = @('public schema')
  excludedSchemas = @('auth','storage','realtime','vault','graphql','graphql_public','pgbouncer','supabase_migrations')
  snapshot = [ordered]@{ path = $dump; sha256 = $hash; bytes = (Get-Item $dump).Length }
  target = [ordered]@{ postgresVersion = '17'; host = '127.0.0.1'; port = $TargetPort; database = $TargetDatabase; queuePolicy = 'PENDING/RUNNING imported jobs cancelled and archived' }
  counts = $counts.Trim().Split('|')
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $snapshot 'manifest.json') -Encoding UTF8
Remove-Item Env:PGPASSWORD
Write-Output "Clonación completada. Snapshot: $snapshot"
