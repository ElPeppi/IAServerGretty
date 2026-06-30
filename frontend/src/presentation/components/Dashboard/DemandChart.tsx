import { useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';
import type { DashboardStats } from '../../../domain/types/dashboard';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

type Period = 'day' | 'week' | 'month';

interface Props {
  stats: DashboardStats;
}

export function DemandChart({ stats }: Props) {
  const [period, setPeriod] = useState<Period>('day');

  const data = {
    day: stats.byDay.map((d) => ({
      label: format(parseISO(d.date), 'd MMM', { locale: es }),
      Demandas: d.count,
    })),
    week: stats.byWeek.map((d) => ({
      label: `Sem ${format(parseISO(d.week), 'd MMM', { locale: es })}`,
      Demandas: d.count,
    })),
    month: stats.byMonth.map((d) => ({
      label: d.month,
      Demandas: d.count,
    })),
  };

  const currentData = data[period];

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-semibold text-gray-900">Demandas Generadas</h3>
          <p className="text-sm text-gray-500 mt-0.5">Actividad por período</p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                period === p ? 'bg-white shadow-sm text-purple-600' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {p === 'day' ? 'Día' : p === 'week' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        {period === 'month' ? (
          <BarChart data={currentData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', boxShadow: 'none' }}
            />
            <Bar dataKey="Demandas" fill="#9333ea" radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : (
          <AreaChart data={currentData}>
            <defs>
              <linearGradient id="colorDemandas" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#9333ea" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#9333ea" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', boxShadow: 'none' }}
            />
            <Area
              type="monotone"
              dataKey="Demandas"
              stroke="#9333ea"
              strokeWidth={2}
              fill="url(#colorDemandas)"
              dot={false}
              activeDot={{ r: 4, fill: '#9333ea' }}
            />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
