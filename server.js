require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const multer = require('multer');

const connectDB = require('./src/config/db');
const User = require('./src/models/User');
const invoiceRoutes = require('./src/routes/invoices');
const reconciliationRoutes = require('./src/routes/reconciliation');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Hash de fallback para contrasena admin
const ADMIN_PASSWORD_HASH = '$2b$10$GbssOZq3ZYpNtOGMVgiswO9pOb0xBg70/3tLd5bNGEDarhtjcf8l2';

// Secreto para firmar tokens de sesion (HS256). Si no se define SESSION_SECRET se genera uno por arranque.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Conectar a MongoDB Atlas y asegurar usuario admin
const initDatabase = async () => {
  await connectDB();
  // Sin conexion no tiene sentido esperar el timeout de Mongoose para crear el admin
  if (mongoose.connection.readyState !== 1) return;
  try {
    const existingAdmin = await User.findOne({ username: ADMIN_USERNAME.toLowerCase() });
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await User.create({
        username: ADMIN_USERNAME,
        name: 'Administrador',
        password: hashedPassword,
        role: 'Administrador'
      });
      console.log(`[Auth] Usuario ${ADMIN_USERNAME} inicial creado con contrasena hasheada.`);
    }
  } catch (err) {
    console.error('[Auth] Error asegurando usuario admin:', err.message);
  }
};
initDatabase();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Servir archivos estaticos
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Asegurar carpeta uploads local
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Las rutas de datos requieren MongoDB: si no hay conexion, responder de inmediato con un mensaje claro
// en lugar de dejar la peticion colgada ~10 s hasta el timeout interno de Mongoose.
const requireDatabase = (req, res, next) => {
  const state = mongoose.connection.readyState; // 0 desconectado, 1 conectado, 2 conectando, 3 desconectando
  if (state === 1 || state === 2) return next();
  return res.status(503).json({
    success: false,
    message: process.env.MONGODB_URI
      ? 'La base de datos no esta disponible en este momento. Intente de nuevo en unos segundos.'
      : 'La base de datos no esta configurada (falta MONGODB_URI en el archivo .env).'
  });
};

// Rutas de API
app.use('/api/invoices', invoiceRoutes);
app.use('/api/reconciliation', requireDatabase, reconciliationRoutes);

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Token de sesion con formato JWT firmado con HMAC-SHA256 (antes la firma no era verificable) */
const generateSessionToken = (userId, ttlSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: String(userId), iat: now, exp: now + ttlSeconds }));
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
};

/** Comparacion de texto en tiempo constante para no filtrar informacion por tiempos de respuesta */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

// ================= RUTAS DE PAGINAS (HTML) =================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'html', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'html', 'dashboard.html'));
});

// ================= API DE AUTENTICACION =================

app.post('/api/auth/login', async (req, res) => {
  const { username, email, password, rememberMe } = req.body || {};
  const loginIdentifier = String(username || email || '').trim().toLowerCase();

  if (!loginIdentifier || !password || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Debe ingresar el usuario y la contrasena.'
    });
  }

  try {
    let user = null;
    try {
      if (mongoose.connection.readyState === 1) {
        user = await User.findOne({ username: loginIdentifier });
      }
    } catch (dbErr) {
      user = null;
    }

    let isPasswordValid = false;
    let userId = 'usr_admin';
    let userName = 'Administrador';
    let userRole = 'Administrador';

    if (user) {
      // compare asincrono: no bloquea el servidor mientras calcula el hash
      isPasswordValid = user.password ? await bcrypt.compare(password, user.password) : false;
      userId = user._id;
      userName = user.name || 'Administrador';
      userRole = user.role || 'Administrador';
    } else if (
      loginIdentifier === ADMIN_USERNAME.toLowerCase() ||
      loginIdentifier === 'admin' ||
      loginIdentifier === 'admin@empresa.com'
    ) {
      // Fallback si la base de datos esta en modo local
      isPasswordValid = safeEqual(password, ADMIN_PASSWORD) || (await bcrypt.compare(password, ADMIN_PASSWORD_HASH));
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Usuario o contrasena incorrectos.'
      });
    }

    // La duracion del token ahora coincide con "Recordarme" (antes siempre expiraba a las 24 h)
    const token = generateSessionToken(userId, rememberMe ? 3600 * 24 * 30 : 3600 * 24);

    return res.status(200).json({
      success: true,
      message: 'Sesion iniciada correctamente.',
      token,
      user: {
        id: userId,
        username: user?.username || ADMIN_USERNAME,
        name: userName,
        role: userRole
      },
      duration: rememberMe ? '30d' : '24h'
    });
  } catch (err) {
    console.error('Error en login:', err);
    return res.status(500).json({
      success: false,
      message: 'Error interno en la autenticacion.'
    });
  }
});

app.get('/api/health', (req, res) => {
  const dbStates = ['Desconectado', 'Conectado', 'Conectando', 'Desconectando'];
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'Comparador de Facturas API',
    database: process.env.MONGODB_URI ? 'MongoDB Atlas Configurado' : 'Modo Memoria',
    databaseState: dbStates[mongoose.connection.readyState] || 'Desconocido',
    storage: process.env.R2_ACCOUNT_ID ? 'Cloudflare R2 Configurado' : 'Disco Local'
  });
});

// Manejador de rutas no encontradas para la API
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}`
  });
});

// Middleware global de manejo de errores
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  // Errores de subida de archivos (tamano, cantidad o campo inesperado) son errores del cliente
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'El archivo excede el tamano maximo permitido.',
      LIMIT_FILE_COUNT: 'Se excedio el numero maximo de archivos por envio.',
      LIMIT_UNEXPECTED_FILE: 'Campo de archivo inesperado en el formulario.'
    };
    return res.status(400).json({ success: false, message: messages[err.code] || err.message });
  }

  // JSON mal formado en el cuerpo de la peticion
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'El cuerpo de la peticion no es JSON valido.' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[Error No Controlado]:', err);
  res.status(status).json({
    success: false,
    message: err.message || 'Error interno del servidor.'
  });
});

// Registrar promesas rechazadas sin manejar en lugar de que pasen desapercibidas
process.on('unhandledRejection', (reason) => {
  console.error('[Promesa no manejada]:', reason);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`Servidor activo en: http://localhost:${PORT}`);
  console.log(`Login: http://localhost:${PORT}/`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Base de Datos: ${process.env.MONGODB_URI ? 'MongoDB Atlas' : 'Local/Memoria'}`);
  console.log(`Storage PDFs: ${process.env.R2_ACCOUNT_ID ? 'Cloudflare R2' : 'Carpeta /uploads'}`);
  console.log(`======================================================\n`);
});
