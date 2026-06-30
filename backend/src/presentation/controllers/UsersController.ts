import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../infrastructure/database/prisma/client';
import { encryptPassword, decryptPassword } from '../../infrastructure/services/passwordCrypto';
import { AuthRequest } from '../middlewares/authMiddleware';

// Gestión de usuarios. Todas las rutas que usan este controlador están detrás de
// authenticate + requireAdmin, así que solo un ADMIN/TI puede crear o listar.
export class UsersController {
  async list(_req: AuthRequest, res: Response): Promise<void> {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, name: true, role: true, createdAt: true,
        _count: { select: { documents: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  }

  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { email, name, password, role } = req.body as {
        email?: string; name?: string; password?: string; role?: string;
      };
      if (!email || !name || !password) {
        res.status(400).json({ message: 'email, name y password son requeridos' });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
        return;
      }
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        res.status(409).json({ message: 'Ese correo ya está registrado' });
        return;
      }
      const hashed = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          email, name,
          password: hashed,
          passwordEnc: encryptPassword(password),
          role: role === 'ADMIN' ? 'ADMIN' : 'LAWYER',
        },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });
      res.status(201).json(user);
    } catch (e) {
      res.status(500).json({ message: e instanceof Error ? e.message : 'Error al crear usuario' });
    }
  }

  // Un ADMIN/TI fija una nueva contraseña para cualquier usuario (no puede VER
  // la actual: bcrypt es de una sola vía; lo que sí puede es restablecerla).
  async resetPassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const { newPassword } = req.body as { newPassword?: string };
      if (!newPassword || newPassword.length < 6) {
        res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
        return;
      }
      const exists = await prisma.user.findUnique({ where: { id } });
      if (!exists) { res.status(404).json({ message: 'Usuario no encontrado' }); return; }
      await prisma.user.update({
        where: { id },
        data: { password: await bcrypt.hash(newPassword, 12), passwordEnc: encryptPassword(newPassword) },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e instanceof Error ? e.message : 'Error al restablecer contraseña' });
    }
  }

  // Un ADMIN/TI ve la contraseña actual de un usuario (copia cifrada reversible).
  // Solo disponible para contraseñas creadas/cambiadas tras activar esta función.
  async viewPassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const user = await prisma.user.findUnique({ where: { id }, select: { passwordEnc: true } });
      if (!user) { res.status(404).json({ message: 'Usuario no encontrado' }); return; }
      if (!user.passwordEnc) {
        res.json({ password: null, message: 'Sin copia visible. Restablécela una vez para poder verla.' });
        return;
      }
      try {
        res.json({ password: decryptPassword(user.passwordEnc) });
      } catch {
        // La copia se cifró con otra llave (PASSWORD_ENC_KEY distinta) → no descifra.
        res.json({ password: null, message: 'No se pudo descifrar (cambió la llave). Restablece la contraseña una vez.' });
      }
    } catch (e) {
      res.status(500).json({ message: e instanceof Error ? e.message : 'Error al obtener contraseña' });
    }
  }

  async remove(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      if (id === req.user?.userId) {
        res.status(400).json({ message: 'No puedes eliminar tu propio usuario' });
        return;
      }
      const docCount = await prisma.document.count({ where: { lawyerId: id } });
      if (docCount > 0) {
        res.status(409).json({ message: `El usuario tiene ${docCount} demanda(s) asignada(s). Reasígnalas antes de eliminarlo.` });
        return;
      }
      await prisma.user.delete({ where: { id } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e instanceof Error ? e.message : 'Error al eliminar usuario' });
    }
  }
}
