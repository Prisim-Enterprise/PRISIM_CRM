-- Clients can be marked Suspended. Placed after On hold so lists sort Active, On hold, Suspended, Completed.
ALTER TYPE "ClientStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED' AFTER 'ON_HOLD';
