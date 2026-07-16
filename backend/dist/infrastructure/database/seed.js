"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("./prisma/client");
async function main() {
    const password = await bcryptjs_1.default.hash('admin123', 12);
    const admin = await client_1.prisma.user.upsert({
        where: { email: 'admin@legaloffice.com' },
        update: {},
        create: {
            email: 'admin@legaloffice.com',
            password,
            name: 'Administrador',
            role: 'ADMIN',
        },
    });
    const lawyer = await client_1.prisma.user.upsert({
        where: { email: 'abogado@legaloffice.com' },
        update: {},
        create: {
            email: 'abogado@legaloffice.com',
            password,
            name: 'Lic. María González',
            role: 'LAWYER',
        },
    });
    // Nota: ya NO se siembran documentos de prueba. Las demandas reales se crean
    // al generarlas desde la página (/generate/singular) o importando las
    // existentes de la NAS con `npm run db:import-docs`.
    console.log('Seed completado (solo usuarios)');
    console.log('Admin:', admin.email, '/ password: admin123');
    console.log('Abogado:', lawyer.email, '/ password: admin123');
}
main()
    .catch(console.error)
    .finally(() => client_1.prisma.$disconnect());
//# sourceMappingURL=seed.js.map