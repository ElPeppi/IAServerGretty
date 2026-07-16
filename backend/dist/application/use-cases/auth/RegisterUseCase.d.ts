import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { IJwtService } from '../../services/IJwtService';
export interface RegisterInput {
    email: string;
    password: string;
    name: string;
    role?: 'ADMIN' | 'LAWYER';
}
export declare class RegisterUseCase {
    private readonly userRepository;
    private readonly jwtService;
    constructor(userRepository: IUserRepository, jwtService: IJwtService);
    execute(input: RegisterInput): Promise<{
        token: string;
        user: import("../../../domain/entities/User").UserPublic;
    }>;
}
//# sourceMappingURL=RegisterUseCase.d.ts.map