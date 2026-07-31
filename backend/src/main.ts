import 'dotenv/config';
import app from './presentation/app';

const PORT = process.env.PORT || 3001;

// Se ata a 127.0.0.1 a propósito: el backend sirve /docs (la raíz del NAS) sin
// autenticación, así que NO debe quedar expuesto en la red. Los clientes entran
// por el frontend (Vite), que proxea /api, /docs y /uploads hacia aquí.
// HOST=0.0.0.0 solo si algo delante ya controla el acceso (nginx, ALB…).
const HOST = process.env.HOST || '127.0.0.1';

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Backend corriendo en http://${HOST}:${PORT}`);
  console.log(`📊 Health check: http://${HOST}:${PORT}/health`);
});
