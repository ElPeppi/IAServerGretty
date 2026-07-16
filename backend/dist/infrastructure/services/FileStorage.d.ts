export interface StoredFile {
    url: string;
    filename: string;
    mimeType: string;
}
export declare class FileStorage {
    private ensureDir;
    saveBuffer(buffer: Buffer, filename: string, mimeType?: string): StoredFile;
    saveBase64(content: string, filename: string, mimeType?: string): StoredFile;
}
//# sourceMappingURL=FileStorage.d.ts.map