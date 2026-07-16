"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("../../infrastructure/database/prisma/client");
const passwordCrypto_1 = require("../../infrastructure/services/passwordCrypto");
// Gestión de usuarios. Todas las rutas que usan este controlador están detrás de
// authenticate + requireAdmin, así que solo un ADMIN/TI puede crear o listar.
class UsersController {
    async list(_req, res) {
        const users = await client_1.prisma.user.findMany({
            select: {
                id: true, email: true, name: true, role: true, createdAt: true,
                _count: { select: { documents: true } },
            },
            orderBy: { createdAt: 'asc' },
        });
        res.json(users);
    }
    async create(req, res) {
        try {
            const { email, name, password, role } = req.body;
            if (!email || !name || !password) {
                res.status(400).json({ message: 'email, name y password son requeridos' });
                return;
            }
            if (password.length < 6) {
                res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
                return;
            }
            const exists = await client_1.prisma.user.findUnique({ where: { email } });
            if (exists) {
                res.status(409).json({ message: 'Ese correo ya está registrado' });
                return;
            }
            const hashed = await bcryptjs_1.default.hash(password, 12);
            const user = await client_1.prisma.user.create({
                data: {
                    email, name,
                    password: hashed,
                    passwordEnc: (0, passwordCrypto_1.encryptPassword)(password),
                    role: role === 'ADMIN' ? 'ADMIN' : 'LAWYER',
                },
                select: { id: true, email: true, name: true, role: true, createdAt: true },
            });
            res.status(201).json(user);
        }
        catch (e) {
            res.status(500).json({ message: e instanceof Error ? e.message : 'Error al crear usuario' });
        }
    }
    // Un ADMIN/TI fija una nueva contraseña para cualquier usuario (no puede VER
    // la actual: bcrypt es de una sola vía; lo que sí puede es restablecerla).
    async resetPassword(req, res) {
        try {
            const id = req.params['id'];
            const { newPassword } = req.body;
            if (!newPassword || newPassword.length < 6) {
                res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
                return;
            }
            const exists = await client_1.prisma.user.findUnique({ where: { id } });
            if (!exists) {
                res.status(404).json({ message: 'Usuario no encontrado' });
                return;
            }
            await client_1.prisma.user.update({
                where: { id },
                data: { password: await bcryptjs_1.default.hash(newPassword, 12), passwordEnc: (0, passwordCrypto_1.encryptPassword)(newPassword) },
            });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e instanceof Error ? e.message : 'Error al restablecer contraseña' });
        }
    }
    // Un ADMIN/TI ve la contraseña actual de un usuario (copia cifrada reversible).
    // Solo disponible para contraseñas creadas/cambiadas tras activar esta función.
    async viewPassword(req, res) {
        try {
            const id = req.params['id'];
            const user = await client_1.prisma.user.findUnique({ where: { id }, select: { passwordEnc: true } });
            if (!user) {
                res.status(404).json({ message: 'Usuario no encontrado' });
                return;
            }
            if (!user.passwordEnc) {
                res.json({ password: null, message: 'Sin copia visible. Restablécela una vez para poder verla.' });
                return;
            }
            try {
                res.json({ password: (0, passwordCrypto_1.decryptPassword)(user.passwordEnc) });
            }
            catch {
                // La copia se cifró con otra llave (PASSWORD_ENC_KEY distinta) → no descifra.
                res.json({ password: null, message: 'No se pudo descifrar (cambió la llave). Restablece la contraseña una vez.' });
            }
        }
        catch (e) {
            res.status(500).json({ message: e instanceof Error ? e.message : 'Error al obtener contraseña' });
        }
    }
    async remove(req, res) {
        try {
            const id = req.params['id'];
            if (id === req.user?.userId) {
                res.status(400).json({ message: 'No puedes eliminar tu propio usuario' });
                return;
            }
            const docCount = await client_1.prisma.document.count({ where: { lawyerId: id } });
            if (docCount > 0) {
                res.status(409).json({ message: `El usuario tiene ${docCount} demanda(s) asignada(s). Reasígnalas antes de eliminarlo.` });
                return;
            }
            await client_1.prisma.user.delete({ where: { id } });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e instanceof Error ? e.message : 'Error al eliminar usuario' });
        }
    }
}
exports.UsersController = UsersController;
//# sourceMappingURL=UsersController.js.map