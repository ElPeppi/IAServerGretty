import { useState } from 'react';
import type { Document } from '../../../domain/types/document';

interface Props {
  document: Document;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function SignatureModal({ document, onConfirm, onClose }: Props) {
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSign = async () => {
    setIsSigning(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al firmar el documento');
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 z-10">
        {/* Icon */}
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-purple-100 mx-auto mb-4">
          <svg className="w-7 h-7 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </div>

        <h2 className="text-xl font-bold text-gray-900 text-center mb-1">Firmar Documento</h2>
        <p className="text-gray-500 text-sm text-center mb-6">
          Confirma que deseas aplicar tu firma digital a este documento.
        </p>

        {/* Document info */}
        <div className="bg-gray-50 rounded-xl p-4 mb-5 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Documento</span>
            <span className="font-medium text-gray-900 text-right max-w-[200px] truncate">{document.title}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Cliente</span>
            <span className="font-medium text-gray-900">{document.clientName}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Abogado</span>
            <span className="font-medium text-gray-900">{document.lawyer.name}</span>
          </div>
        </div>

        {/* Signature preview */}
        {document.lawyer.signatureUrl && (
          <div className="border border-gray-200 rounded-xl p-3 mb-5">
            <p className="text-xs text-gray-400 mb-2">Vista previa de firma</p>
            <img
              src={document.lawyer.signatureUrl}
              alt="Firma del abogado"
              className="h-16 object-contain mx-auto"
            />
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={isSigning}
            className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSign}
            disabled={isSigning}
            className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isSigning ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Firmando...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Confirmar Firma
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
