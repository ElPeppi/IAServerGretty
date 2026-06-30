-- AlterTable: anexos generados + notas de procedencia + cédula del cliente
ALTER TABLE "documents"
  ADD COLUMN "anexosUrl"       TEXT,
  ADD COLUMN "antecedentesUrl" TEXT,
  ADD COLUMN "asignacionUrl"   TEXT,
  ADD COLUMN "poderUrl"        TEXT,
  ADD COLUMN "notes"           JSONB,
  ADD COLUMN "clientCedula"    TEXT;
