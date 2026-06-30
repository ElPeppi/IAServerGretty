import bcrypt from 'bcryptjs';
import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { IJwtService } from '../../services/IJwtService';
import { toPublicUser } from '../../../domain/entities/User';

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  role?: 'ADMIN' | 'LAWYER';
}

export class RegisterUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly jwtService: IJwtService
  ) {}

  async execute(input: RegisterInput) {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      throw new Error('El correo ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(input.password, 12);
    const user = await this.userRepository.create({
      ...input,
      password: hashedPassword,
    });

    const token = this.jwtService.sign({ userId: user.id, role: user.role });
    return { token, user: toPublicUser(user) };
  }
}
