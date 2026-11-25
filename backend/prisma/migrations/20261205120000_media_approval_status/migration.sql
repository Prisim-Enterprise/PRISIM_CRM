-- Media entries can wait for the client's approval, then be approved, before they are posted.
ALTER TYPE "MediaStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL' BEFORE 'DONE';
ALTER TYPE "MediaStatus" ADD VALUE IF NOT EXISTS 'APPROVED' BEFORE 'DONE';
