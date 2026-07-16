import { IN8nService, GenerateDemandInput, GenerateDemandOutput, SignDocumentInput } from '../../application/services/IN8nService';
export declare class N8nService implements IN8nService {
    private readonly baseUrl;
    private readonly generateWebhook;
    private readonly signWebhook;
    constructor();
    generateDemand(input: GenerateDemandInput): Promise<GenerateDemandOutput>;
    signDocument(input: SignDocumentInput): Promise<string>;
}
//# sourceMappingURL=N8nService.d.ts.map