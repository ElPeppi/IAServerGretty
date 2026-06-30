import axios from 'axios';
import {
  IN8nService,
  GenerateDemandInput,
  GenerateDemandOutput,
  SignDocumentInput,
} from '../../application/services/IN8nService';

export class N8nService implements IN8nService {
  private readonly baseUrl: string;
  private readonly generateWebhook: string;
  private readonly signWebhook: string;

  constructor() {
    this.baseUrl = process.env.N8N_BASE_URL || 'http://localhost:5678';
    this.generateWebhook = process.env.N8N_GENERATE_WEBHOOK || '/webhook/generate-demand';
    this.signWebhook = process.env.N8N_SIGN_WEBHOOK || '/webhook/sign-document';
  }

  async generateDemand(input: GenerateDemandInput): Promise<GenerateDemandOutput> {
    const url = `${this.baseUrl}${this.generateWebhook}`;
    const { data } = await axios.post<GenerateDemandOutput>(url, input, { timeout: 60000 });
    return data;
  }

  async signDocument(input: SignDocumentInput): Promise<string> {
    const url = `${this.baseUrl}${this.signWebhook}`;
    const { data } = await axios.post<{ signedUrl: string }>(url, input, { timeout: 60000 });
    return data.signedUrl;
  }
}
