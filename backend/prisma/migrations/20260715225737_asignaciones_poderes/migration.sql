-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "asignacionId" TEXT;

-- CreateTable
CREATE TABLE "asignaciones" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "fechaAsignacion" TIMESTAMP(3),
    "excelUrl" TEXT,
    "filas" JSONB NOT NULL,
    "totalFilas" INTEGER NOT NULL DEFAULT 0,
    "poderUrl" TEXT,
    "poderGeneradoAt" TIMESTAMP(3),
    "docsEnServidor" BOOLEAN NOT NULL DEFAULT false,
    "lawyerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asignaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poderes" (
    "id" TEXT NOT NULL,
    "asignacionId" TEXT NOT NULL,
    "cedula" TEXT NOT NULL,
    "nombre" TEXT,
    "ciudadJuzgado" TEXT,
    "tipoJuzgado" TEXT,
    "numeroPagare" TEXT,
    "pagareDesdeDocs" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poderes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asignaciones_nombre_key" ON "asignaciones"("nombre");

-- CreateIndex
CREATE INDEX "asignaciones_lawyerId_createdAt_idx" ON "asignaciones"("lawyerId", "createdAt");

-- CreateIndex
CREATE INDEX "poderes_asignacionId_idx" ON "poderes"("asignacionId");

-- CreateIndex
CREATE INDEX "poderes_cedula_idx" ON "poderes"("cedula");

-- CreateIndex
CREATE INDEX "documents_asignacionId_idx" ON "documents"("asignacionId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_asignacionId_fkey" FOREIGN KEY ("asignacionId") REFERENCES "asignaciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poderes" ADD CONSTRAINT "poderes_asignacionId_fkey" FOREIGN KEY ("asignacionId") REFERENCES "asignaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
