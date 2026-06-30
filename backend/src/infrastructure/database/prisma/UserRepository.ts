import { prisma } from './client';
import { User } from '../../../domain/entities/User';
import {
  IUserRepository,
  CreateUserDTO,
  UpdateUserDTO,
} from '../../../domain/repositories/IUserRepository';

export class PrismaUserRepository implements IUserRepository {
  async findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  async create(data: CreateUserDTO): Promise<User> {
    return prisma.user.create({ data });
  }

  async update(id: string, data: UpdateUserDTO): Promise<User> {
    return prisma.user.update({ where: { id }, data });
  }
}
