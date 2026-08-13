-- CreateTable
CREATE TABLE "datos_manuales" (
    "cedula" TEXT NOT NULL,
    "numeroPagare" TEXT,
    "fechaSuscripcion" TEXT,
    "nota" TEXT,
    "autorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datos_manuales_pkey" PRIMARY KEY ("cedula")
);
