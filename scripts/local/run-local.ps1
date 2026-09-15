param(
  [ValidateSet('dev','worker','analysis-worker','scheduler')]
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
$env:DB_EXPECTED_MIGRATION = '202609140002_advisor_rls_hardening'
$env:ENABLE_OCI_PROVIDER = 'true'
$env:INGESTION_SCHEDULER_PROVIDER = 'oci'
$isApi = $Mode -eq 'dev'
$isWorker = $Mode -eq 'worker'
$isAnalysisWorker = $Mode -eq 'analysis-worker'
$isScheduler = $Mode -eq 'scheduler'
$env:APP_PROCESS_ROLE = if ($isApi) { 'api' } elseif ($isWorker) { 'worker' } elseif ($isAnalysisWorker) { 'recommendation-analysis-worker' } else { 'scheduler' }
$env:INGESTION_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:INGESTION_SCHEDULER_ENABLED = if ($Mode -eq 'scheduler') { 'true' } else { 'false' }
# Keep the HTTP API free of background work. The default dev mode starts the
# recommendation worker as a separate hidden process; provider/LLM failures
# therefore cannot take down the login/API process.
$env:METRIC_PROJECTION_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:AGENT_LEARNING_WORKER_ENABLED = if ($isWorker) { 'true' } else { 'false' }
$env:RECOMMENDATION_ANALYSIS_WORKER_ENABLED = if ($isWorker -or $isAnalysisWorker) { 'true' } else { 'false' }
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
 $recommendationWorkerProcess = $null
 $exitCode = 0
 try {
  if ($Mode -eq 'dev') {
    $workerScript = Join-Path $PSScriptRoot 'run-local.ps1'
    $workerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$workerScript`" -Mode analysis-worker"
    $recommendationWorkerProcess = Start-Process `
      -FilePath 'powershell.exe' `
      -ArgumentList $workerArguments `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -PassThru
    Write-Output "Worker de recomendaciones activo por defecto (PID $($recommendationWorkerProcess.Id))."
    # `dev` is the local API entrypoint; the worker runs separately so the
    # analysis provider cannot block or crash the HTTP API.
    npm run dev:api
  } else {
    npx tsx src/index.ts
  }
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
 } finally {
  if ($null -ne $recommendationWorkerProcess -and -not $recommendationWorkerProcess.HasExited) {
    & taskkill.exe /PID $recommendationWorkerProcess.Id /T /F | Out-Null
  }
}
 exit $exitCode
