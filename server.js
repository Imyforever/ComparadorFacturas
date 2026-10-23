require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

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

// Conectar a MongoDB Atlas y asegurar usuario admin
const initDatabase = async () => {
  await connectDB();
  try {
    const existingAdmin = await User.findOne({ username: ADMIN_USERNAME });
    if (!existingAdmin) {
      const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estaticos
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Asegurar carpeta uploads local
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Rutas de API
app.use('/api/invoices', invoiceRoutes);
app.use('/api/reconciliation', reconciliationRoutes);

const generateSessionToken = (userId) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 * 24, iat: Math.floor(Date.now() / 1000) })
  ).toString('base64');
  const signature = Buffer.from(`sec_${userId}_${Date.now()}`).toString('base64');
  return `${header}.${payload}.${signature}`;
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
  const { username, email, password, rememberMe } = req.body;
  const loginIdentifier = (username || email || '').trim().toLowerCase();

  if (!loginIdentifier || !password) {
    return res.status(400).json({
      success: false,
      message: 'Debe ingresar el usuario y la contrasena.'
    });
  }

  try {
    let user = null;
    try {
      user = await User.findOne({ username: loginIdentifier });
    } catch (dbErr) {
      user = null;
    }

    let isPasswordValid = false;
    let userId = 'usr_admin';
    let userName = 'Administrador';
    let userRole = 'Administrador';

    if (user) {
      isPasswordValid = bcrypt.compareSync(password, user.password);
      userId = user._id;
      userName = user.name || 'Administrador';
      userRole = user.role || 'Administrador';
    } else if (
      loginIdentifier === ADMIN_USERNAME.toLowerCase() ||
      loginIdentifier === 'admin' ||
      loginIdentifier === 'admin@empresa.com'
    ) {
      // Fallback si la base de datos esta en modo local
      isPasswordValid = password === ADMIN_PASSWORD || bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Usuario o contrasena incorrectos.'
      });
    }

    const token = generateSessionToken(userId);

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
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'Comparador de Facturas API',
    database: process.env.MONGODB_URI ? 'MongoDB Atlas Configurado' : 'Modo Memoria',
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
  console.error('[Error No Controlado]:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Error interno del servidor.'
  });
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
