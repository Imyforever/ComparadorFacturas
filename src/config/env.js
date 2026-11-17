require('dotenv').config();
const crypto = require('crypto');

let fallbackSessionSecret = '';
if (!process.env.SESSION_SECRET) {
  fallbackSessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[Auth] SESSION_SECRET no esta definido en .env. Se genero un secreto aleatorio para esta sesion.');
}

const env = {
  get PORT() {
    return process.env.PORT || 3000;
  },
  get MONGODB_URI() {
    return process.env.MONGODB_URI || '';
  },
  get ADMIN_USERNAME() {
    return process.env.ADMIN_USERNAME || 'admin';
  },
  get ADMIN_PASSWORD() {
    // Sin valor por defecto: si no se configura, el acceso de respaldo y la creacion del admin se desactivan
    return process.env.ADMIN_PASSWORD || '';
  },
  get SESSION_SECRET() {
    return process.env.SESSION_SECRET || fallbackSessionSecret;
  },
  get R2_ACCOUNT_ID() {
    return process.env.R2_ACCOUNT_ID || '';
  },
  get R2_ACCESS_KEY_ID() {
    return process.env.R2_ACCESS_KEY_ID || '';
  },
  get R2_SECRET_ACCESS_KEY() {
    return process.env.R2_SECRET_ACCESS_KEY || '';
  },
  get R2_BUCKET_NAME() {
    return process.env.R2_BUCKET_NAME || '';
  },
  get R2_PUBLIC_URL() {
    return process.env.R2_PUBLIC_URL || '';
  },
  get isR2Configured() {
    return Boolean(this.R2_ACCOUNT_ID && this.R2_ACCESS_KEY_ID && this.R2_SECRET_ACCESS_KEY && this.R2_BUCKET_NAME);
  }
};

module.exports = env;
