import bcrypt from 'bcryptjs';
import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { IJwtService } from '../../services/IJwtService';
import { toPublicUser } from '../../../domain/entities/User';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginOutput {
  token: string;
  user: ReturnType<typeof toPublicUser>;
}

export class LoginUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly jwtService: IJwtService
  ) {}

  async execute(input: LoginInput): Promise<LoginOutput> {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user) {
      throw new Error('Credenciales inválidas');
    }

    const isPasswordValid = await bcrypt.compare(input.password, user.password);
    if (!isPasswordValid) {
      throw new Error('Credenciales inválidas');
    }

    const token = this.jwtService.sign({ userId: user.id, role: user.role });

    return { token, user: toPublicUser(user) };
  }
}
