param(
  [ValidateSet('dev','worker','scheduler')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pgRoot = if ($env:FINOPS_POSTGRES_ROOT) { $env:FINOPS_POSTGRES_ROOT } else { 'C:\FinOpsData\postgres17' }
$passwordFile = Join-Path $pgRoot 'superuser.pass'
if (!(Test-Path $passwordFile)) { throw "No existe $passwordFile. Prepara PostgreSQL local antes de iniciar el backend." }

& (Join-Path $PSScriptRoot 'start-postgres17.ps1')
$password = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
$encodedPassword = [Uri]::EscapeDataString($password)
$env:DATABASE_URL = "postgresql://postgres:$encodedPassword@127.0.0.1:5433/finops_local"
$env:DB_RUNTIME_ENFORCE = 'true'
$env:DB_RUNTIME_ROLE = 'finops_runtime'
$env:ENABLE_OCI_PROVIDER = 'true'
$env:INGESTION_SCHEDULER_PROVIDER = 'oci'
$env:APP_PROCESS_ROLE = if ($Mode -eq 'dev') { 'all' } elseif ($Mode -eq 'worker') { 'ingestion-worker' } else { 'ingestion-scheduler' }
$env:INGESTION_WORKER_ENABLED = if ($Mode -eq 'scheduler') { 'false' } else { 'true' }
$env:INGESTION_SCHEDULER_ENABLED = if ($Mode -eq 'worker') { 'false' } else { 'true' }
$env:INGESTION_WORKER_CONCURRENCY = if ($env:INGESTION_WORKER_CONCURRENCY) { $env:INGESTION_WORKER_CONCURRENCY } else { '4' }
$env:INGESTION_SCHEDULER_MAX_ATTEMPTS = '3'
$env:INGESTION_SCHEDULER_METRIC_CATCHUP_DAYS = '90'
$env:INGESTION_SCHEDULER_INTERVAL_MS = if ($env:INGESTION_SCHEDULER_INTERVAL_MS) { $env:INGESTION_SCHEDULER_INTERVAL_MS } else { '300000' }
$env:INGESTION_WORKER_INTERVAL_MS = if ($env:INGESTION_WORKER_INTERVAL_MS) { $env:INGESTION_WORKER_INTERVAL_MS } else { '1000' }

Write-Output "Backend local: PostgreSQL 17 en 127.0.0.1:5433/finops_local; scheduler y worker activos mientras esta ventana permanezca abierta."
Set-Location $repoRoot
if ($Mode -eq 'dev') {
  npm run dev
} elseif ($Mode -eq 'worker') {
  npm run ingestion:worker:once
} else {
  # Ejecutar directamente para conservar --apply; npm run puede interpretar
  # flags posteriores como configuración propia en algunas versiones.
  npx tsx scripts/schedule-ingestion-jobs.ts --apply --provider $env:INGESTION_SCHEDULER_PROVIDER
}
