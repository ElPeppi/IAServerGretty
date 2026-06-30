export type DocumentStatus = 'PENDING' | 'GENERATED' | 'SIGNED' | 'REJECTED';

export interface DocumentLawyer {
  id: string;
  name: string;
  email: string;
  signatureUrl?: string | null;
}

/** Nota de procedencia/faltante que el motor adjunta a la demanda. */
export interface DocumentNote {
  campo: string;
  nivel: 'info' | 'warning';
  mensaje: string;
}

export interface Document {
  id: string;
  title: string;
  type: string;
  status: DocumentStatus;
  fileUrl?: string | null;          // demanda (Word) — panel izquierdo
  signedUrl?: string | null;
  anexosUrl?: string | null;        // panel derecho
  antecedentesUrl?: string | null;
  asignacionUrl?: string | null;
  poderUrl?: string | null;
  notes?: DocumentNote[] | null;
  clientName: string;
  clientRfc?: string | null;
  clientCedula?: string | null;
  description?: string | null;
  lawyerId: string;
  lawyer: DocumentLawyer;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  signedAt?: string | null;
}
