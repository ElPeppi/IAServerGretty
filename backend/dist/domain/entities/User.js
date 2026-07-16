"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPublicUser = toPublicUser;
function toPublicUser(user) {
    const { password: _pw, updatedAt: _up, ...pub } = user;
    return pub;
}
//# sourceMappingURL=User.js.map