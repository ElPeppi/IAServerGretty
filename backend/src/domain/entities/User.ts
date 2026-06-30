export type Role = 'ADMIN' | 'LAWYER';

export interface User {
  id: string;
  email: string;
  password: string;
  name: string;
  role: Role;
  signatureUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: Role;
  signatureUrl?: string | null;
  createdAt: Date;
}

export function toPublicUser(user: User): UserPublic {
  const { password: _pw, updatedAt: _up, ...pub } = user;
  return pub;
}
