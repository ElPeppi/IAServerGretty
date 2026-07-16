"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.N8nService = void 0;
const axios_1 = __importDefault(require("axios"));
class N8nService {
    constructor() {
        this.baseUrl = process.env.N8N_BASE_URL || 'http://localhost:5678';
        this.generateWebhook = process.env.N8N_GENERATE_WEBHOOK || '/webhook/generate-demand';
        this.signWebhook = process.env.N8N_SIGN_WEBHOOK || '/webhook/sign-document';
    }
    async generateDemand(input) {
        const url = `${this.baseUrl}${this.generateWebhook}`;
        const { data } = await axios_1.default.post(url, input, { timeout: 60000 });
        return data;
    }
    async signDocument(input) {
        const url = `${this.baseUrl}${this.signWebhook}`;
        const { data } = await axios_1.default.post(url, input, { timeout: 60000 });
        return data.signedUrl;
    }
}
exports.N8nService = N8nService;
//# sourceMappingURL=N8nService.js.map