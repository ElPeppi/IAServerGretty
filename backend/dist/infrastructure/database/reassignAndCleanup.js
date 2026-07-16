"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Limpia los usuarios de prueba:
 *  - Reasigna TODAS las demandas al usuario ADMIN (quita "Lic. María González"
 *    de las tarjetas).
 *  - Elimina los usuarios que no son ADMIN (la abogada demo).
 *  - Normaliza el nombre visible del admin.
 *
 *   npm run db:cleanup-users
 */
require("dotenv/config");
const client_1 = require("./prisma/client");
async function main() {
    const admin = await client_1.prisma.user.findFirst({
        where: { role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
    });
    if (!admin) {
        console.error('❌ No hay usuario ADMIN. Corre primero `npm run prisma:seed`.');
        process.exit(1);
    }
    const reasignadas = await client_1.prisma.document.updateMany({ data: { lawyerId: admin.id } });
    console.log(`✓ Reasignadas ${reasignadas.count} demanda(s) al admin (${admin.email}).`);
    const eliminados = await client_1.prisma.user.deleteMany({ where: { role: { not: 'ADMIN' } } });
    console.log(`✓ Eliminados ${eliminados.count} usuario(s) no-admin (demo).`);
    await client_1.prisma.user.update({ where: { id: admin.id }, data: { name: 'Administrador (TI)' } });
    console.log(`✓ Admin normalizado: ${admin.email} → "Administrador (TI)"`);
}
main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => client_1.prisma.$disconnect());
//# sourceMappingURL=reassignAndCleanup.js.map