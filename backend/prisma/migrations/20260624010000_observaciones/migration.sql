-- Observaciones: clientes del Excel para los que NO se generó la demanda y por qué.
CREATE TABLE "observaciones" (
    "id"        TEXT NOT NULL,
    "cedula"    TEXT NOT NULL,
    "nombre"    TEXT,
    "motivo"    TEXT NOT NULL,
    "lote"      TEXT,
    "lawyerId"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "observaciones_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "observaciones_lawyerId_createdAt_idx" ON "observaciones"("lawyerId", "createdAt");
CREATE INDEX "observaciones_createdAt_idx" ON "observaciones"("createdAt");

ALTER TABLE "observaciones" ADD CONSTRAINT "observaciones_lawyerId_fkey"
    FOREIGN KEY ("lawyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
