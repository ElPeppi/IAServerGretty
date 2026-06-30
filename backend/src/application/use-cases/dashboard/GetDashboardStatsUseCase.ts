import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';

export class GetDashboardStatsUseCase {
  constructor(private readonly documentRepository: IDocumentRepository) {}

  async execute(lawyerId?: string) {
    return this.documentRepository.getDashboardStats(lawyerId);
  }
}
