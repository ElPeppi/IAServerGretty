import { apiClient } from './client';
import type { AuthResponse, LoginCredentials, RegisterData, User } from '../../domain/types/auth';

export const authApi = {
  login: (credentials: LoginCredentials) =>
    apiClient.post<AuthResponse>('/auth/login', credentials).then((r) => r.data),

  register: (data: RegisterData) =>
    apiClient.post<AuthResponse>('/auth/register', data).then((r) => r.data),

  me: () => apiClient.get<User>('/auth/me').then((r) => r.data),

  updateProfile: (data: { name?: string; signatureUrl?: string }) =>
    apiClient.patch<User>('/auth/profile', data).then((r) => r.data),

  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiClient.patch<{ ok: boolean }>('/auth/password', data).then((r) => r.data),
};
