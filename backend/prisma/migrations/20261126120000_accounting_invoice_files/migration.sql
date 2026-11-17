CREATE TABLE "acct_invoice_files" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalBytes" INTEGER NOT NULL,
    "encoding" TEXT,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acct_invoice_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acct_invoice_files_storageKey_key" ON "acct_invoice_files"("storageKey");
CREATE INDEX "acct_invoice_files_clientId_createdAt_idx" ON "acct_invoice_files"("clientId", "createdAt");

ALTER TABLE "acct_invoice_files" ADD CONSTRAINT "acct_invoice_files_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acct_invoice_files" ENABLE ROW LEVEL SECURITY;