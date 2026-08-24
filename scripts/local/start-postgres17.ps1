param(
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$root = if ($env:FINOPS_POSTGRES_ROOT) { $env:FINOPS_POSTGRES_ROOT } else { 'C:\FinOpsData\postgres17' }
$bin = Join-Path $root 'pgsql\bin'
$data = Join-Path $root 'data'
$log = Join-Path $root 'server.log'
$pgCtl = Join-Path $bin 'pg_ctl.exe'
$pgIsReady = Join-Path $bin 'pg_isready.exe'
$port = if ($env:FINOPS_POSTGRES_PORT) { [int]$env:FINOPS_POSTGRES_PORT } else { 5433 }

if (!(Test-Path $pgCtl) -or !(Test-Path $data)) {
  throw "No se encontró PostgreSQL 17 en $root. Ejecuta primero la preparación local o instala los binarios oficiales."
}

if ($Stop) {
  & $pgCtl -D $data -m fast -w stop
  exit $LASTEXITCODE
}

& $pgIsReady -h 127.0.0.1 -p $port *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Output "PostgreSQL local ya está activo en 127.0.0.1:$port."
  exit 0
}

& $pgCtl -D $data -l $log -w start
if ($LASTEXITCODE -ne 0) {
  throw "No fue posible iniciar PostgreSQL local. Revisa $log."
}

Write-Output "PostgreSQL local iniciado en 127.0.0.1:$port."
