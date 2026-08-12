-- DropIndex
DROP INDEX "poderes_asignacionId_idx";

-- AlterTable
ALTER TABLE "asignaciones" ADD COLUMN     "poderPagoDirectoAt" TIMESTAMP(3),
ADD COLUMN     "poderPagoDirectoUrl" TEXT;

-- AlterTable
ALTER TABLE "poderes" ADD COLUMN     "marca" TEXT,
ADD COLUMN     "modelo" TEXT,
ADD COLUMN     "placa" TEXT,
ADD COLUMN     "tipo" TEXT NOT NULL DEFAULT 'SINGULAR';

-- CreateIndex
CREATE INDEX "poderes_asignacionId_tipo_idx" ON "poderes"("asignacionId", "tipo");
