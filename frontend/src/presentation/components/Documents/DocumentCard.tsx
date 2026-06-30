import { useNavigate } from 'react-router-dom';
import type { Document } from '../../../domain/types/document';
import { DocumentStatusBadge } from './DocumentStatusBadge';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

export function DocumentCard({ doc }: { doc: Document }) {
  const navigate = useNavigate();

  return (
    <div
      onClick={() => navigate(`/documents/${doc.id}`)}
      className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:border-purple-200 hover:shadow-md cursor-pointer transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 truncate">{doc.title}</p>
          <p className="text-sm text-gray-500 mt-0.5 truncate">Cliente: {doc.clientName}</p>
        </div>
        <DocumentStatusBadge status={doc.status} />
      </div>

      {doc.clientRfc && (
        <p className="text-xs text-gray-400 mb-3">RFC: {doc.clientRfc}</p>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-gray-50">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 text-xs font-semibold">
            {doc.lawyer.name.charAt(0)}
          </div>
          <span className="text-xs text-gray-500 truncate max-w-[120px]">{doc.lawyer.name}</span>
        </div>
        <span className="text-xs text-gray-400">
          {format(new Date(doc.createdAt), 'd MMM yyyy', { locale: es })}
        </span>
      </div>
    </div>
  );
}
