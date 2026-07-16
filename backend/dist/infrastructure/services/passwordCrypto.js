"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPassword = encryptPassword;
exports.decryptPassword = decryptPassword;
const crypto_1 = __importDefault(require("crypto"));
// Cifrado reversible de contraseñas (AES-256-GCM) para que un ADMIN pueda VERlas.
// OJO: esto es distinto del hash bcrypt usado para el login. La llave viene de
// PASSWORD_ENC_KEY (en producción debe definirse y mantenerse en secreto).
const KEY = crypto_1.default
    .createHash('sha256')
    .update(process.env.PASSWORD_ENC_KEY || 'gretty-dev-key-CAMBIAR-en-produccion')
    .digest(); // 32 bytes
if (!process.env.PASSWORD_ENC_KEY) {
    console.warn('[WARN] PASSWORD_ENC_KEY no definida: usando llave de desarrollo. Defínela en producción.');
}
function encryptPassword(plain) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptPassword(stored) {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
//# sourceMappingURL=passwordCrypto.js.map