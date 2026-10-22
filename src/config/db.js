const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.warn('[MongoDB] MONGODB_URI no esta definido en el archivo .env.');
    console.warn('[MongoDB] Operando en modo local/memoria temporal hasta configurar MongoDB Atlas.');
    return;
  }

  try {
    const conn = await mongoose.connect(uri);
    console.log(`[MongoDB Atlas] Conectado exitosamente: ${conn.connection.host}`);
  } catch (error) {
    console.error(`[MongoDB Atlas] Error de conexion: ${error.message}`);
    // No detenemos el servidor por completo para permitir diagnostico
  }
};

module.exports = connectDB;
