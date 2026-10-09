import { Request, Response, NextFunction } from 'express';
import { JwtService } from '../../infrastructure/services/JwtService';

export interface AuthRequest extends Request {
  user?: { userId: string; role: string };
}

const jwtService = new JwtService();

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Token requerido' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwtService.verify(token);
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

/**
 * Para lo que llama n8n, que no tiene sesión de usuario: secreto compartido en
 * el header `x-n8n-secret` (= N8N_SECRET). Sin N8N_SECRET configurado, todo se
 * rechaza.
 */
export function authenticateN8n(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.N8N_SECRET || '';
  if (!secret || req.headers['x-n8n-secret'] !== secret) {
    res.status(401).json({ message: 'no autorizado' });
    return;
  }
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ message: 'Acceso denegado' });
    return;
  }
  next();
}
