export type Role = 'ADMIN' | 'LAWYER';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  signatureUrl?: string | null;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData extends LoginCredentials {
  name: string;
  role?: Role;
}
