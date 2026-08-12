-- Adds an explicit outbound type for the daily executive FinOps summary.
-- This is additive and preserves all existing delivery history.
ALTER TYPE "OutboundMessageType" ADD VALUE IF NOT EXISTS 'EXECUTIVE_SUMMARY';
