import jwt from 'jsonwebtoken';
import { IJwtService, JwtPayload } from '../../application/services/IJwtService';

export class JwtService implements IJwtService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor() {
    this.secret = process.env.JWT_SECRET || 'fallback-secret';
    this.expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  }

  sign(payload: JwtPayload): string {
    return jwt.sign(payload, this.secret, { expiresIn: this.expiresIn } as jwt.SignOptions);
  }

  verify(token: string): JwtPayload {
    return jwt.verify(token, this.secret) as JwtPayload;
  }
}
