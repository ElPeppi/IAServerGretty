import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { LoginUseCase } from '../../application/use-cases/auth/LoginUseCase';
import { RegisterUseCase } from '../../application/use-cases/auth/RegisterUseCase';
import { UpdateProfileUseCase } from '../../application/use-cases/auth/UpdateProfileUseCase';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { prisma } from '../../infrastructure/database/prisma/client';
import { encryptPassword } from '../../infrastructure/services/passwordCrypto';
import { JwtService } from '../../infrastructure/services/JwtService';
import { AuthRequest } from '../middlewares/authMiddleware';

const userRepository = new PrismaUserRepository();
const jwtService = new JwtService();
const loginUseCase = new LoginUseCase(userRepository, jwtService);
const registerUseCase = new RegisterUseCase(userRepository, jwtService);
const updateProfileUseCase = new UpdateProfileUseCase(userRepository);

export class AuthController {
  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ message: 'Email y contraseña requeridos' });
        return;
      }
      const result = await loginUseCase.execute({ email, password });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      res.status(401).json({ message });
    }
  }

  async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, password, name, role } = req.body;
      if (!email || !password || !name) {
        res.status(400).json({ message: 'Campos requeridos: email, password, name' });
        return;
      }
      const result = await registerUseCase.execute({ email, password, name, role });
      res.status(201).json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      res.status(400).json({ message });
    }
  }

  async me(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = await userRepository.findById(req.user!.userId);
      if (!user) {
        res.status(404).json({ message: 'Usuario no encontrado' });
        return;
      }
      const { password: _pw, ...pub } = user;
      res.json(pub);
    } catch {
      res.status(500).json({ message: 'Error interno' });
    }
  }

  async updateProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await updateProfileUseCase.execute({
        userId: req.user!.userId,
        ...req.body,
      });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      res.status(400).json({ message });
    }
  }

  // Cada usuario cambia SU propia contraseña (verificando la actual).
  async changePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
      if (!currentPassword || !newPassword) {
        res.status(400).json({ message: 'Contraseña actual y nueva son requeridas' });
        return;
      }
      if (newPassword.length < 6) {
        res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
        return;
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
      if (!user) { res.status(404).json({ message: 'Usuario no encontrado' }); return; }
      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) { res.status(400).json({ message: 'La contraseña actual es incorrecta' }); return; }
      await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(newPassword, 12), passwordEnc: encryptPassword(newPassword) },
      });
      res.json({ ok: true });
    } catch (error: unknown) {
      res.status(500).json({ message: error instanceof Error ? error.message : 'Error al cambiar contraseña' });
    }
  }
}
