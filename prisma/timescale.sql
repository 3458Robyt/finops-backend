-- Optional TimescaleDB hardening for environments where the extension is installed.
-- Run after the initial Prisma migration:
--   psql "$DATABASE_URL" -f prisma/timescale.sql

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
  'cost_metrics',
  by_range('charge_period_start'),
  if_not_exists => TRUE
);
