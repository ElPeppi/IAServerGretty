import { useDashboard } from '../../application/hooks/useDashboard';
import { useAuth } from '../../application/context/AuthContext';
import { StatsCards } from '../components/Dashboard/StatsCards';
import { DemandChart } from '../components/Dashboard/DemandChart';
import { StatusPieChart } from '../components/Dashboard/StatusPieChart';
import { ObservacionesPanel } from '../components/Dashboard/ObservacionesPanel';
import { useNavigate } from 'react-router-dom';

export function DashboardPage() {
  const { stats, isLoading, error } = useDashboard();
  const { user } = useAuth();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-gray-200 rounded-xl" />
            ))}
          </div>
          <div className="h-72 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Bienvenido, {user?.name} — aquí está el resumen de tu actividad
          </p>
        </div>
        <button
          onClick={() => navigate('/documents')}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Ver Documentos
        </button>
      </div>

      {stats && (
        <div className="space-y-6">
          <StatsCards stats={stats} />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <DemandChart stats={stats} />
            </div>
            <StatusPieChart byStatus={stats.byStatus} />
          </div>

          {/* Observaciones: demandas no generadas y por qué */}
          <ObservacionesPanel />
        </div>
      )}
    </div>
  );
}
