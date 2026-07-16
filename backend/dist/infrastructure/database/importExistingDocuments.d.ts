/**
 * Importa a la base de datos las demandas YA generadas que están en la NAS,
 * para que aparezcan en la página. Recorre las carpetas por cédula de `DOCS_DIR`
 * y crea un Document por cada una que tenga su DEMANDA .docx.
 *
 *   DOCS_DIR="/mnt/compartida/.../GARANTIAS" npm run db:import-docs
 *
 * Requiere que el backend sirva `DOCS_DIR` en /docs (ver app.ts) para poder verlas.
 * No duplica: salta las cédulas que ya tienen una demanda singular importada.
 */
import 'dotenv/config';
//# sourceMappingURL=importExistingDocuments.d.ts.map