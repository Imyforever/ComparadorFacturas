const mongoose = require('mongoose');
const env = require('./env');

const connectDB = async () => {
  const uri = env.MONGODB_URI;

  if (!uri) {
    console.warn('[MongoDB] MONGODB_URI no esta definido en el archivo .env.');
    console.warn('[MongoDB] Operando en modo local/memoria temporal hasta configurar MongoDB Atlas.');
    return;
  }

  mongoose.connection.on('disconnected', () => console.warn('[MongoDB Atlas] Conexion perdida.'));
  mongoose.connection.on('reconnected', () => console.log('[MongoDB Atlas] Conexion restablecida.'));
  mongoose.connection.on('error', (err) => console.error(`[MongoDB Atlas] Error: ${err.message}`));

  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    console.log(`[MongoDB Atlas] Conectado exitosamente: ${conn.connection.host}`);
  } catch (error) {
    console.error(`[MongoDB Atlas] Error de conexion: ${error.message}`);
  }
};

module.exports = connectDB;
