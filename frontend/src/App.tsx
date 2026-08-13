import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './application/context/AuthContext';
import { NotificationProvider } from './application/context/NotificationContext';
import { PrivateRoute } from './presentation/router/PrivateRoute';
import { MainLayout } from './presentation/components/Layout/MainLayout';
import { LoginPage } from './presentation/pages/LoginPage';
import { DashboardPage } from './presentation/pages/DashboardPage';
import { DocumentsPage } from './presentation/pages/DocumentsPage';
import { AsignacionesPage } from './presentation/pages/AsignacionesPage';
import { ExpedientesPage } from './presentation/pages/ExpedientesPage';
import { DocumentDetailPage } from './presentation/pages/DocumentDetailPage';
import { UsersPage } from './presentation/pages/UsersPage';
import { ConfigPage } from './presentation/pages/ConfigPage';

function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected */}
          <Route
            path="/"
            element={
              <PrivateRoute>
                <MainLayout />
              </PrivateRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="asignaciones" element={<AsignacionesPage />} />
            <Route path="expedientes" element={<ExpedientesPage />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="documents/:id" element={<DocumentDetailPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="config" element={<ConfigPage />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      </NotificationProvider>
    </AuthProvider>
  );
}

export default App;
