const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');
const env = require('./env');

const isR2Configured = env.isR2Configured;

let s3Client = null;

if (isR2Configured) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY
    }
  });
  console.log('[Cloudflare R2] Cliente de almacenamiento configurado.');
} else {
  console.log('[Cloudflare R2] Claves no detectadas en .env. Usando almacenamiento local (/uploads).');
}

/**
 * Sube un archivo PDF a Cloudflare R2 o a disco local si no hay claves
 * @param {Object} file - Archivo proveniente de multer (buffer, originalname, mimetype)
 * @returns {Promise<{url: string, key: string, storage: 'r2'|'local'}>}
 */
const uploadPdf = async (file) => {
  if (!file || !file.buffer) {
    throw new Error('No se recibio el contenido del archivo.');
  }
  const timestamp = Date.now();
  const safeName = (file.originalname || 'archivo.pdf')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .slice(-120);
  const fileKey = `facturas/${timestamp}_${safeName}`;

  if (isR2Configured && s3Client) {
    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/pdf'
    });

    await s3Client.send(command);

    const publicBase = env.R2_PUBLIC_URL
      ? env.R2_PUBLIC_URL.replace(/\/$/, '')
      : `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const url = `${publicBase}/${fileKey}`;

    return {
      url,
      key: fileKey,
      storage: 'r2'
    };
  }

  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
  await fs.promises.mkdir(uploadsDir, { recursive: true });

  const localFileName = `${timestamp}_${safeName}`;
  const localFilePath = path.join(uploadsDir, localFileName);
  await fs.promises.writeFile(localFilePath, file.buffer);

  return {
    url: `/uploads/${localFileName}`,
    key: localFileName,
    storage: 'local'
  };
};

module.exports = {
  uploadPdf,
  isR2Configured
};
