export interface JwtPayload {
    userId: string;
    role: string;
}
export interface IJwtService {
    sign(payload: JwtPayload): string;
    verify(token: string): JwtPayload;
}
//# sourceMappingURL=IJwtService.d.ts.map