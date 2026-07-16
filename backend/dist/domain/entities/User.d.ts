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
export declare function toPublicUser(user: User): UserPublic;
//# sourceMappingURL=User.d.ts.map