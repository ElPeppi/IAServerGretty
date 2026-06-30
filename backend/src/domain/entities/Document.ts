export type DocumentStatus = 'PENDING' | 'GENERATED' | 'SIGNED' | 'REJECTED';

/** Nota de procedencia/faltante generada por el motor al armar la demanda. */
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
  fileUrl?: string | null;          // demanda (Word) — panel izquierdo del visor
  signedUrl?: string | null;
  anexosUrl?: string | null;        // panel derecho del visor
  antecedentesUrl?: string | null;
  asignacionUrl?: string | null;
  poderUrl?: string | null;
  notes?: DocumentNote[] | null;
  clientName: string;
  clientRfc?: string | null;
  clientCedula?: string | null;
  description?: string | null;
  lawyerId: string;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  signedAt?: Date | null;
}

export interface DocumentWithLawyer extends Document {
  lawyer: {
    id: string;
    name: string;
    email: string;
    signatureUrl?: string | null;
  };
}
