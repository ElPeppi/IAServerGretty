import { IJwtService, JwtPayload } from '../../application/services/IJwtService';
export declare class JwtService implements IJwtService {
    private readonly secret;
    private readonly expiresIn;
    constructor();
    sign(payload: JwtPayload): string;
    verify(token: string): JwtPayload;
}
//# sourceMappingURL=JwtService.d.ts.map