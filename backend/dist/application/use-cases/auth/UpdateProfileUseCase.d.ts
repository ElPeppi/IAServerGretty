import { IUserRepository } from '../../../domain/repositories/IUserRepository';
export interface UpdateProfileInput {
    userId: string;
    name?: string;
    signatureUrl?: string;
}
export declare class UpdateProfileUseCase {
    private readonly userRepository;
    constructor(userRepository: IUserRepository);
    execute(input: UpdateProfileInput): Promise<import("../../../domain/entities/User").UserPublic>;
}
//# sourceMappingURL=UpdateProfileUseCase.d.ts.map