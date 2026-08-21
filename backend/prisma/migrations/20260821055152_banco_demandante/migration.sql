-- AlterTable
ALTER TABLE "asignaciones" ADD COLUMN     "banco" TEXT NOT NULL DEFAULT 'FINANDINA';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "banco" TEXT NOT NULL DEFAULT 'FINANDINA';

-- CreateIndex
CREATE INDEX "asignaciones_banco_idx" ON "asignaciones"("banco");

-- CreateIndex
CREATE INDEX "documents_banco_createdAt_idx" ON "documents"("banco", "createdAt");
