"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
exports.requireAdmin = requireAdmin;
const JwtService_1 = require("../../infrastructure/services/JwtService");
const jwtService = new JwtService_1.JwtService();
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ message: 'Token requerido' });
        return;
    }
    const token = authHeader.slice(7);
    try {
        req.user = jwtService.verify(token);
        next();
    }
    catch {
        res.status(401).json({ message: 'Token inválido o expirado' });
    }
}
function requireAdmin(req, res, next) {
    if (req.user?.role !== 'ADMIN') {
        res.status(403).json({ message: 'Acceso denegado' });
        return;
    }
    next();
}
//# sourceMappingURL=authMiddleware.js.map