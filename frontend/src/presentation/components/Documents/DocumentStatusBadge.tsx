import type { DocumentStatus } from '../../../domain/types/document';

const config: Record<DocumentStatus, { label: string; classes: string }> = {
  PENDING:   { label: 'Pendiente',  classes: 'bg-amber-50 text-amber-700 border border-amber-200' },
  GENERATED: { label: 'Generada',   classes: 'bg-blue-50 text-blue-700 border border-blue-200' },
  SIGNED:    { label: 'Firmada',    classes: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  REJECTED:  { label: 'Rechazada',  classes: 'bg-red-50 text-red-700 border border-red-200' },
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const { label, classes } = config[status] ?? { label: status, classes: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}>
      {label}
    </span>
  );
}
