/**
 * Agrega la columna passwordEnc (si falta) y rellena la del admin por defecto
 * (sabemos su contraseña inicial). Las demás contraseñas se vuelven visibles
 * cuando se cambian/restablecen una vez.
 *
 *   npm run db:passwordenc
 */
import 'dotenv/config';
import { prisma } from './prisma/client';
import { encryptPassword } from '../services/passwordCrypto';

async function main() {
  await prisma.$executeRawUnsafe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordEnc" TEXT');
  const r = await prisma.user.updateMany({
    where: { email: 'admin@legaloffice.com' },
    data: { passwordEnc: encryptPassword('admin123') },
  });
  console.log(`✓ Columna passwordEnc lista; admin backfilled: ${r.count}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
