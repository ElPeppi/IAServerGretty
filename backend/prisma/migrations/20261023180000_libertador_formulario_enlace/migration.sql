-- AlterTable
ALTER TABLE "libertador_solicitudes" ADD COLUMN     "formularioEnlace" TEXT,
ADD COLUMN     "formularioEnviadoEn" TIMESTAMP(3),
ADD COLUMN     "formularioEnviadoPor" TEXT,
ADD COLUMN     "formularioTexto" TEXT;

