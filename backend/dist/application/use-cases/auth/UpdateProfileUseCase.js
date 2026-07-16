"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateProfileUseCase = void 0;
const User_1 = require("../../../domain/entities/User");
class UpdateProfileUseCase {
    constructor(userRepository) {
        this.userRepository = userRepository;
    }
    async execute(input) {
        const { userId, ...data } = input;
        const user = await this.userRepository.update(userId, data);
        return (0, User_1.toPublicUser)(user);
    }
}
exports.UpdateProfileUseCase = UpdateProfileUseCase;
//# sourceMappingURL=UpdateProfileUseCase.js.map