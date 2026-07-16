import { User } from '../../../domain/entities/User';
import { IUserRepository, CreateUserDTO, UpdateUserDTO } from '../../../domain/repositories/IUserRepository';
export declare class PrismaUserRepository implements IUserRepository {
    findById(id: string): Promise<User | null>;
    findByEmail(email: string): Promise<User | null>;
    create(data: CreateUserDTO): Promise<User>;
    update(id: string, data: UpdateUserDTO): Promise<User>;
}
//# sourceMappingURL=UserRepository.d.ts.map