import { User } from '../entities/User';

export interface CreateUserDTO {
  email: string;
  password: string;
  name: string;
  role?: 'ADMIN' | 'LAWYER';
}

export interface UpdateUserDTO {
  name?: string;
  signatureUrl?: string;
}

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(data: CreateUserDTO): Promise<User>;
  update(id: string, data: UpdateUserDTO): Promise<User>;
}
