export interface GenerateDemandInput {
  lawyerId: string;
  lawyerName: string;
  clientName: string;
  clientRfc?: string;
  excelData: Record<string, unknown>[];
  templateType?: string;
}

export interface GenerateDemandOutput {
  documentId: string;
  fileUrl: string;
  title: string;
}

export interface SignDocumentInput {
  documentId: string;
  fileUrl: string;
  lawyerName: string;
  signatureUrl: string;
}

export interface IN8nService {
  generateDemand(input: GenerateDemandInput): Promise<GenerateDemandOutput>;
  signDocument(input: SignDocumentInput): Promise<string>;
}
