"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const LoginUseCase_1 = require("../../application/use-cases/auth/LoginUseCase");
const RegisterUseCase_1 = require("../../application/use-cases/auth/RegisterUseCase");
const UpdateProfileUseCase_1 = require("../../application/use-cases/auth/UpdateProfileUseCase");
const UserRepository_1 = require("../../infrastructure/database/prisma/UserRepository");
const client_1 = require("../../infrastructure/database/prisma/client");
const passwordCrypto_1 = require("../../infrastructure/services/passwordCrypto");
const JwtService_1 = require("../../infrastructure/services/JwtService");
const userRepository = new UserRepository_1.PrismaUserRepository();
const jwtService = new JwtService_1.JwtService();
const loginUseCase = new LoginUseCase_1.LoginUseCase(userRepository, jwtService);
const registerUseCase = new RegisterUseCase_1.RegisterUseCase(userRepository, jwtService);
const updateProfileUseCase = new UpdateProfileUseCase_1.UpdateProfileUseCase(userRepository);
class AuthController {
    async login(req, res) {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                res.status(400).json({ message: 'Email y contraseña requeridos' });
                return;
            }
            const result = await loginUseCase.execute({ email, password });
            res.json(result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error desconocido';
            res.status(401).json({ message });
        }
    }
    async register(req, res) {
        try {
            const { email, password, name, role } = req.body;
            if (!email || !password || !name) {
                res.status(400).json({ message: 'Campos requeridos: email, password, name' });
                return;
            }
            const result = await registerUseCase.execute({ email, password, name, role });
            res.status(201).json(result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error desconocido';
            res.status(400).json({ message });
        }
    }
    async me(req, res) {
        try {
            const user = await userRepository.findById(req.user.userId);
            if (!user) {
                res.status(404).json({ message: 'Usuario no encontrado' });
                return;
            }
            const { password: _pw, ...pub } = user;
            res.json(pub);
        }
        catch {
            res.status(500).json({ message: 'Error interno' });
        }
    }
    async updateProfile(req, res) {
        try {
            const result = await updateProfileUseCase.execute({
                userId: req.user.userId,
                ...req.body,
            });
            res.json(result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error desconocido';
            res.status(400).json({ message });
        }
    }
    // Cada usuario cambia SU propia contraseña (verificando la actual).
    async changePassword(req, res) {
        try {
            const { currentPassword, newPassword } = req.body;
            if (!currentPassword || !newPassword) {
                res.status(400).json({ message: 'Contraseña actual y nueva son requeridas' });
                return;
            }
            if (newPassword.length < 6) {
                res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
                return;
            }
            const user = await client_1.prisma.user.findUnique({ where: { id: req.user.userId } });
            if (!user) {
                res.status(404).json({ message: 'Usuario no encontrado' });
                return;
            }
            const ok = await bcryptjs_1.default.compare(currentPassword, user.password);
            if (!ok) {
                res.status(400).json({ message: 'La contraseña actual es incorrecta' });
                return;
            }
            await client_1.prisma.user.update({
                where: { id: user.id },
                data: { password: await bcryptjs_1.default.hash(newPassword, 12), passwordEnc: (0, passwordCrypto_1.encryptPassword)(newPassword) },
            });
            res.json({ ok: true });
        }
        catch (error) {
            res.status(500).json({ message: error instanceof Error ? error.message : 'Error al cambiar contraseña' });
        }
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=AuthController.js.map