-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "counterpartyWalletId" TEXT,
ADD COLUMN     "transferId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_transferId_idx" ON "Transaction"("transferId");
