"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegisterUseCase = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const User_1 = require("../../../domain/entities/User");
class RegisterUseCase {
    constructor(userRepository, jwtService) {
        this.userRepository = userRepository;
        this.jwtService = jwtService;
    }
    async execute(input) {
        const existing = await this.userRepository.findByEmail(input.email);
        if (existing) {
            throw new Error('El correo ya está registrado');
        }
        const hashedPassword = await bcryptjs_1.default.hash(input.password, 12);
        const user = await this.userRepository.create({
            ...input,
            password: hashedPassword,
        });
        const token = this.jwtService.sign({ userId: user.id, role: user.role });
        return { token, user: (0, User_1.toPublicUser)(user) };
    }
}
exports.RegisterUseCase = RegisterUseCase;
//# sourceMappingURL=RegisterUseCase.js.map