-- CreateTable
CREATE TABLE "libertador_solicitudes" (
    "solicitud" TEXT NOT NULL,
    "procesos" TEXT[],
    "tipoAlistamiento" TEXT,
    "estadoSiniestro" TEXT,
    "canon" INTEGER,
    "deuda" INTEGER,
    "asuntoCorreo" TEXT,
    "vecesRecibida" INTEGER NOT NULL DEFAULT 1,
    "recibidaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimaRecepcion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "carpetaEstado" TEXT,
    "carpetaNombre" TEXT,
    "carpetaId" TEXT,
    "carpetaDetalle" TEXT,
    "anexosEstado" TEXT,
    "anexosCantidad" INTEGER,
    "anexosDetalle" TEXT,
    "formularioEstado" TEXT,
    "formularioDetalle" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "libertador_solicitudes_pkey" PRIMARY KEY ("solicitud")
);

-- CreateIndex
CREATE INDEX "libertador_solicitudes_ultimaRecepcion_idx" ON "libertador_solicitudes"("ultimaRecepcion");

