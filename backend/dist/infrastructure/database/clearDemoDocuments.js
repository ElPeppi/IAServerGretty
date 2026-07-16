"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Borra los documentos de PRUEBA (datos sembrados) de la base de datos.
 *
 *   npm run db:clear            → borra solo los falsos (seed / example.com)
 *   CLEAR_ALL=1 npm run db:clear → borra TODOS los documentos
 *
 * No toca usuarios. Los documentos reales (type = 'DEMANDA_SINGULAR') se conservan
 * salvo que uses CLEAR_ALL=1.
 */
require("dotenv/config");
const client_1 = require("./prisma/client");
async function main() {
    const all = process.env.CLEAR_ALL === '1';
    const where = all
        ? {}
        : {
            OR: [
                { fileUrl: { contains: 'example.com' } }, // URLs del seed demo
                { title: { startsWith: 'Demanda Civil #' } }, // títulos del seed demo
                { type: 'DEMANDA' }, // tipo del seed (los reales son DEMANDA_SINGULAR)
            ],
        };
    const { count } = await client_1.prisma.document.deleteMany({ where });
    console.log(`🗑️  Eliminados ${count} documento(s)${all ? ' (TODOS)' : ' de prueba'}`);
}
main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => client_1.prisma.$disconnect());
//# sourceMappingURL=clearDemoDocuments.js.map