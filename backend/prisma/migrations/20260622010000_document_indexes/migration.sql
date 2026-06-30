-- Índices para escalar filtros y ordenamiento de la lista de demandas y el dashboard.
CREATE INDEX "documents_lawyerId_createdAt_idx" ON "documents"("lawyerId", "createdAt");
CREATE INDEX "documents_status_idx"             ON "documents"("status");
CREATE INDEX "documents_clientCedula_idx"       ON "documents"("clientCedula");
CREATE INDEX "documents_createdAt_idx"          ON "documents"("createdAt");
