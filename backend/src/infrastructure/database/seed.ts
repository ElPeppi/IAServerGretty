import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma/client';

async function main() {
  const password = await bcrypt.hash('admin123', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@legaloffice.com' },
    update: {},
    create: {
      email: 'admin@legaloffice.com',
      password,
      name: 'Administrador',
      role: 'ADMIN',
    },
  });

  const lawyer = await prisma.user.upsert({
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
  .finally(() => prisma.$disconnect());
