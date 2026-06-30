import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../application/context/AuthContext';
import { usersApi, type ManagedUser } from '../../infrastructure/api/usersApi';
import type { Role } from '../../domain/types/auth';

export function UsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // formulario de creación
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('LAWYER');
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);

  // Solo ADMIN: si no lo es, fuera.
  useEffect(() => {
    if (user && user.role !== 'ADMIN') navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  const load = () => {
    setLoading(true);
    usersApi.list()
      .then(setUsers)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error al cargar usuarios'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormMsg(null);
    try {
      await usersApi.create({ email, name, password, role });
      setEmail(''); setName(''); setPassword(''); setRole('LAWYER');
      setFormMsg('✅ Usuario creado');
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setFormMsg('❌ ' + (msg ?? (err instanceof Error ? err.message : 'Error')));
    } finally {
      setSaving(false);
    }
  };

  const [shown, setShown] = useState<Record<string, string>>({});
  const handleView = async (u: ManagedUser) => {
    if (shown[u.id] !== undefined) {
      setShown((s) => { const c = { ...s }; delete c[u.id]; return c; });
      return;
    }
    try {
      const { password, message } = await usersApi.getPassword(u.id);
      if (password == null) { alert(message ?? 'Sin copia visible. Cambia la contraseña una vez para poder verla.'); return; }
      setShown((s) => ({ ...s, [u.id]: password }));
    } catch {
      alert('No se pudo obtener la contraseña');
    }
  };

  const handleResetPassword = async (u: ManagedUser) => {
    const pw = prompt(`Nueva contraseña para ${u.name} (mín. 6 caracteres):`);
    if (pw == null) return;
    if (pw.length < 6) { alert('La contraseña debe tener al menos 6 caracteres.'); return; }
    try {
      await usersApi.resetPassword(u.id, pw);
      alert(`✅ Contraseña actualizada para ${u.name}.\nComunícasela al usuario:\n\n${pw}`);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      alert(msg ?? 'No se pudo cambiar la contraseña');
    }
  };

  const handleDelete = async (u: ManagedUser) => {
    if (!confirm(`¿Eliminar al usuario ${u.name} (${u.email})?`)) return;
    try {
      await usersApi.remove(u.id);
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      alert(msg ?? 'No se pudo eliminar');
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Usuarios</h1>
      <p className="text-gray-500 text-sm mb-6">Gestión de accesos — solo administradores.</p>

      {/* Crear usuario */}
      <form onSubmit={handleCreate} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Crear usuario</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input required type="text" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)}
            className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
          <input required type="email" placeholder="Correo" value={email} onChange={(e) => setEmail(e.target.value)}
            className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
          <input required type="password" placeholder="Contraseña (mín. 6)" value={password} onChange={(e) => setPassword(e.target.value)}
            className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}
            className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500">
            <option value="LAWYER">Abogado</option>
            <option value="ADMIN">Administrador (TI)</option>
          </select>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button type="submit" disabled={saving}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? 'Creando…' : 'Crear usuario'}
          </button>
          {formMsg && <span className="text-sm text-gray-600">{formMsg}</span>}
        </div>
      </form>

      {/* Lista */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-gray-400">Cargando…</div>
        ) : error ? (
          <div className="p-6 text-sm text-red-500">{error}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Nombre</th>
                <th className="text-left px-5 py-3 font-medium">Correo</th>
                <th className="text-left px-5 py-3 font-medium">Rol</th>
                <th className="text-left px-5 py-3 font-medium">Demandas</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-5 py-3 text-gray-600">{u.email}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {u.role === 'ADMIN' ? 'Administrador (TI)' : 'Abogado'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-500">{u._count?.documents ?? 0}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {shown[u.id] !== undefined && (
                      <span className="text-xs font-mono text-gray-700 bg-gray-100 rounded px-2 py-0.5 mr-3">{shown[u.id]}</span>
                    )}
                    <button onClick={() => handleView(u)}
                      className="text-xs text-gray-600 hover:text-gray-900 hover:underline mr-3">
                      {shown[u.id] !== undefined ? 'Ocultar' : 'Ver contraseña'}
                    </button>
                    <button onClick={() => handleResetPassword(u)}
                      className="text-xs text-purple-600 hover:text-purple-800 hover:underline mr-3">Cambiar contraseña</button>
                    {u.id !== user?.id && (
                      <button onClick={() => handleDelete(u)}
                        className="text-xs text-red-500 hover:text-red-700 hover:underline">Eliminar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
