import { apiClient } from './client';
import type { Role } from '../../domain/types/auth';

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  _count?: { documents: number };
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role: Role;
}

export const usersApi = {
  list: () => apiClient.get<ManagedUser[]>('/users').then((r) => r.data),
  create: (data: CreateUserInput) => apiClient.post<ManagedUser>('/users', data).then((r) => r.data),
  getPassword: (id: string) =>
    apiClient.get<{ password: string | null; message?: string }>(`/users/${id}/password`).then((r) => r.data),
  resetPassword: (id: string, newPassword: string) =>
    apiClient.patch<{ ok: boolean }>(`/users/${id}/password`, { newPassword }).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`/users/${id}`).then((r) => r.data),
};
