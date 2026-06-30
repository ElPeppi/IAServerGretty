import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { DashboardStats } from '../../../domain/types/dashboard';

interface Props {
  byStatus: DashboardStats['byStatus'];
}

const STATUS_CONFIG = {
  PENDING:   { label: 'Pendiente',  color: '#f59e0b' },
  GENERATED: { label: 'Generada',   color: '#3b82f6' },
  SIGNED:    { label: 'Firmada',    color: '#10b981' },
  REJECTED:  { label: 'Rechazada',  color: '#ef4444' },
};

export function StatusPieChart({ byStatus }: Props) {
  const data = Object.entries(byStatus)
    .map(([key, value]) => ({
      name: STATUS_CONFIG[key as keyof typeof STATUS_CONFIG]?.label ?? key,
      value,
      color: STATUS_CONFIG[key as keyof typeof STATUS_CONFIG]?.color ?? '#6b7280',
    }))
    .filter((d) => d.value > 0);

  if (data.length === 0) {
    return (
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 flex items-center justify-center h-64">
        <p className="text-gray-400">Sin datos</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h3 className="font-semibold text-gray-900 mb-1">Estado de Demandas</h3>
      <p className="text-sm text-gray-500 mb-4">Distribución actual</p>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={3} dataKey="value">
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value) => [value, 'Cantidad']}
            contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', boxShadow: 'none' }}
          />
          <Legend iconType="circle" iconSize={8} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
