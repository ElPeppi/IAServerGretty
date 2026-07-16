"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Agrega la columna passwordEnc (si falta) y rellena la del admin por defecto
 * (sabemos su contraseña inicial). Las demás contraseñas se vuelven visibles
 * cuando se cambian/restablecen una vez.
 *
 *   npm run db:passwordenc
 */
require("dotenv/config");
const client_1 = require("./prisma/client");
const passwordCrypto_1 = require("../services/passwordCrypto");
async function main() {
    await client_1.prisma.$executeRawUnsafe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordEnc" TEXT');
    const r = await client_1.prisma.user.updateMany({
        where: { email: 'admin@legaloffice.com' },
        data: { passwordEnc: (0, passwordCrypto_1.encryptPassword)('admin123') },
    });
    console.log(`✓ Columna passwordEnc lista; admin backfilled: ${r.count}`);
}
main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => client_1.prisma.$disconnect());
//# sourceMappingURL=backfillPasswordEnc.js.map