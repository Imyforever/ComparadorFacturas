/**
 * Construccion de la aplicacion Express (middlewares, rutas y manejadores de error).
 * Exportable sin levantar el puerto ni conectar a MongoDB para pruebas de integracion.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const env = require('./config/env');
const authMiddleware = require('./middleware/auth');
const requireDatabase = require('./middleware/requireDatabase');
const { apiNotFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const invoiceRoutes = require('./routes/invoices');
const reconciliationRoutes = require('./routes/reconciliation');

const ROOT_DIR = path.join(__dirname, '..');

const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const publicDir = path.join(ROOT_DIR, 'public');
  const uploadsDir = path.join(ROOT_DIR, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  app.use(express.static(publicDir));
  app.use('/uploads', express.static(uploadsDir));

  // Paginas HTML
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'html', 'index.html'));
  });

  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'html', 'dashboard.html'));
  });

  // Rutas publicas de API (no requieren token)
  app.get('/api/health', (req, res) => {
    const dbStates = ['Desconectado', 'Conectado', 'Conectando', 'Desconectando'];
    res.json({
      status: 'online',
      timestamp: new Date().toISOString(),
      service: 'Comparador de Facturas API',
      database: env.MONGODB_URI ? 'MongoDB Atlas Configurado' : 'Modo Memoria',
      databaseState: dbStates[mongoose.connection.readyState] || 'Desconocido',
      storage: env.R2_ACCOUNT_ID ? 'Cloudflare R2 Configurado' : 'Disco Local'
    });
  });

  app.use('/api/auth', authRoutes);

  // Todas las demas rutas bajo /api/* exigen token JWT valido
  app.use('/api', authMiddleware);

  // Rutas protegidas de API
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/reconciliation', requireDatabase, reconciliationRoutes);

  // 404 para rutas de API inexistentes y manejador global de errores
  app.use('/api/*', apiNotFoundHandler);
  app.use(errorHandler);

  return app;
};

const app = createApp();
app.createApp = createApp;

module.exports = app;
