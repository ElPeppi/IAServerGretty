import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationBell } from './NotificationBell';

export function MainLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      {/* El menú es `fixed`, así que se reserva SOLO el ancho del riel colapsado
          (w-16). Al expandirse flota encima y el contenido no se re-maqueta:
          el editor de Word gana ~192px de ancho permanente. */}
      <div className="w-16 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Barra superior: campana de notificaciones a la derecha */}
        <header className="flex-shrink-0 h-12 bg-white border-b border-gray-100 flex items-center justify-end px-4">
          <NotificationBell />
        </header>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
