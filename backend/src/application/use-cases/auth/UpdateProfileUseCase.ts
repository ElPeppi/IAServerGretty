import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { toPublicUser } from '../../../domain/entities/User';

export interface UpdateProfileInput {
  userId: string;
  name?: string;
  signatureUrl?: string;
}

export class UpdateProfileUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(input: UpdateProfileInput) {
    const { userId, ...data } = input;
    const user = await this.userRepository.update(userId, data);
    return toPublicUser(user);
  }
}
