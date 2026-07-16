"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaUserRepository = void 0;
const client_1 = require("./client");
class PrismaUserRepository {
    async findById(id) {
        return client_1.prisma.user.findUnique({ where: { id } });
    }
    async findByEmail(email) {
        return client_1.prisma.user.findUnique({ where: { email } });
    }
    async create(data) {
        return client_1.prisma.user.create({ data });
    }
    async update(id, data) {
        return client_1.prisma.user.update({ where: { id }, data });
    }
}
exports.PrismaUserRepository = PrismaUserRepository;
//# sourceMappingURL=UserRepository.js.map