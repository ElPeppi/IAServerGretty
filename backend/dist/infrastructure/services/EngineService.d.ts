import { IEngineService, GenerateSingularInput, GenerateSingularOutput, DescargarSacInput, DescargarSacOutput, GenerarPoderesInput, GenerarPoderesOutput } from '../../application/services/IEngineService';
export declare class EngineService implements IEngineService {
    private readonly baseUrl;
    constructor();
    generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput>;
    descargarSac(input: DescargarSacInput): Promise<DescargarSacOutput>;
    generarPoderes(input: GenerarPoderesInput): Promise<GenerarPoderesOutput>;
}
//# sourceMappingURL=EngineService.d.ts.map