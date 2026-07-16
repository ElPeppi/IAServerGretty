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
export declare class LoginUseCase {
    private readonly userRepository;
    private readonly jwtService;
    constructor(userRepository: IUserRepository, jwtService: IJwtService);
    execute(input: LoginInput): Promise<LoginOutput>;
}
//# sourceMappingURL=LoginUseCase.d.ts.map