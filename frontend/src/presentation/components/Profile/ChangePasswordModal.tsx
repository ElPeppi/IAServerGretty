import { useState, type FormEvent } from 'react';
import { authApi } from '../../../infrastructure/api/authApi';

const inputCls =
  'w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 ' +
  'text-gray-900 dark:text-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 6) { setMsg('❌ La nueva contraseña debe tener al menos 6 caracteres'); return; }
    if (next !== confirm) { setMsg('❌ Las contraseñas no coinciden'); return; }
    setSaving(true); setMsg(null);
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next });
      setMsg('✅ Contraseña actualizada');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err: unknown) {
      const m = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setMsg('❌ ' + (m ?? 'No se pudo cambiar'));
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm z-10 p-6">
        <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-4">Cambiar mi contraseña</h2>
        <form onSubmit={submit} className="space-y-3">
          <input type="password" placeholder="Contraseña actual" value={current}
            onChange={(e) => setCurrent(e.target.value)} required className={inputCls} />
          <input type="password" placeholder="Nueva contraseña (mín. 6)" value={next}
            onChange={(e) => setNext(e.target.value)} required className={inputCls} />
          <input type="password" placeholder="Confirmar nueva contraseña" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} required className={inputCls} />
          {msg && <p className="text-sm text-gray-700 dark:text-gray-300">{msg}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
              Cerrar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
