/**
 * Punto de entrada del servidor HTTP e inicializacion de MongoDB Atlas.
 */

const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const { ensureAdminUser } = require('./src/services/authService');

const initDatabase = async () => {
  await connectDB();
  await ensureAdminUser();
};

process.on('unhandledRejection', (reason) => {
  console.error('[Promesa no manejada]:', reason);
});

if (require.main === module) {
  initDatabase();

  app.listen(env.PORT, () => {
    console.log(`\n======================================================`);
    console.log(`Servidor activo en: http://localhost:${env.PORT}`);
    console.log(`Login: http://localhost:${env.PORT}/`);
    console.log(`Dashboard: http://localhost:${env.PORT}/dashboard`);
    console.log(`Base de Datos: ${env.MONGODB_URI ? 'MongoDB Atlas' : 'Local/Memoria'}`);
    console.log(`Storage PDFs: ${env.R2_ACCOUNT_ID ? 'Cloudflare R2' : 'Carpeta /uploads'}`);
    console.log(`======================================================\n`);
  });
}

module.exports = { app, initDatabase };
