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
$env:DB_EXPECTED_MIGRATION = '202608310002_messaging_preferences_worker_rls'
$env:ENABLE_OCI_PROVIDER = 'true'
$env:INGESTION_SCHEDULER_PROVIDER = 'oci'
$isApi = $Mode -eq 'dev'
$isWorker = $Mode -eq 'worker'
$isScheduler = $Mode -eq 'scheduler'
$env:APP_PROCESS_ROLE = if ($isApi) { 'api' } elseif ($isWorker) { 'worker' } else { 'scheduler' }
$env:INGESTION_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:INGESTION_SCHEDULER_ENABLED = if ($Mode -eq 'scheduler') { 'true' } else { 'false' }
# Keep the HTTP API free of background work. Use the worker/scheduler commands
# in separate terminals so a provider or LLM failure cannot take down login/API.
$env:METRIC_PROJECTION_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:AGENT_LEARNING_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:RECOMMENDATION_ANALYSIS_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:INGESTION_WORKER_CONCURRENCY = if ($env:INGESTION_WORKER_CONCURRENCY) { $env:INGESTION_WORKER_CONCURRENCY } else { '4' }
$env:INGESTION_JOB_LEASE_MS = if ($env:INGESTION_JOB_LEASE_MS) { $env:INGESTION_JOB_LEASE_MS } else { '120000' }
$env:INGESTION_SCHEDULER_MAX_ATTEMPTS = '3'
$env:INGESTION_SCHEDULER_METRIC_CATCHUP_DAYS = '90'
$env:INGESTION_SCHEDULER_METRIC_CATCHUP_WINDOW_MINUTES = if ($env:INGESTION_SCHEDULER_METRIC_CATCHUP_WINDOW_MINUTES) { $env:INGESTION_SCHEDULER_METRIC_CATCHUP_WINDOW_MINUTES } else { '1440' }
$env:INGESTION_SCHEDULER_MAX_METRIC_BACKFILL_JOBS_PER_CONNECTION = if ($env:INGESTION_SCHEDULER_MAX_METRIC_BACKFILL_JOBS_PER_CONNECTION) { $env:INGESTION_SCHEDULER_MAX_METRIC_BACKFILL_JOBS_PER_CONNECTION } else { '48' }
$env:INGESTION_SCHEDULER_INTERVAL_MS = if ($env:INGESTION_SCHEDULER_INTERVAL_MS) { $env:INGESTION_SCHEDULER_INTERVAL_MS } else { '300000' }
$env:INGESTION_WORKER_INTERVAL_MS = if ($env:INGESTION_WORKER_INTERVAL_MS) { $env:INGESTION_WORKER_INTERVAL_MS } else { '1000' }

Write-Output "Backend local: PostgreSQL 17 en 127.0.0.1:5433/finops_local; proceso '$Mode' activo mientras esta ventana permanezca abierta."
Set-Location $repoRoot
if ($Mode -eq 'dev') {
  # `dev` is the local all-in-one entrypoint. Use the API-only script here to
  # avoid recursively invoking this wrapper.
  npm run dev:api
} elseif ($Mode -eq 'worker') {
  npx tsx src/index.ts
} else {
  npx tsx src/index.ts
}
