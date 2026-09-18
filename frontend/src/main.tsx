import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './application/theme'

initTheme();

// Autocuración de "pantalla en blanco tras un deploy". Cuando el navegador tiene
// cacheado un index.html viejo, un import dinámico (p. ej. el editor de demanda) o
// un <link modulepreload> del arranque apunta a un chunk hasheado que el build
// nuevo ya reemplazó, y su carga falla → sin ErrorBoundary, React desmonta todo y
// queda la pantalla en blanco hasta que el usuario refresca a mano. Vite avisa con
// 'vite:preloadError'; aquí se recarga UNA vez para tomar el build nuevo. El
// anti-bucle (máx. 1 recarga cada 10 s) evita el ciclo si el chunk de verdad no
// existe. El arreglo de raíz es que Nginx sirva index.html con no-cache.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault(); // que no propague como error (si no, igual queda en blanco)
  const last = Number(sessionStorage.getItem('preloadReloadAt') || 0);
  if (Date.now() - last > 10000) {
    sessionStorage.setItem('preloadReloadAt', String(Date.now()));
    window.location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
