-- Classifies the transaccional email generated for a client invitation.
ALTER TYPE "OutboundMessageType" ADD VALUE IF NOT EXISTS 'CLIENT_INVITATION';
