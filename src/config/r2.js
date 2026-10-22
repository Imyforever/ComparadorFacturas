const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL
} = process.env;

const isR2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME;

let s3Client = null;

if (isR2Configured) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
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
  const timestamp = Date.now();
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const fileKey = `facturas/${timestamp}_${safeName}`;

  if (isR2Configured && s3Client) {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/pdf'
    });

    await s3Client.send(command);

    const publicBase = R2_PUBLIC_URL ? R2_PUBLIC_URL.replace(/\/$/, '') : `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const url = `${publicBase}/${fileKey}`;

    return {
      url,
      key: fileKey,
      storage: 'r2'
    };
  }

  // Fallback local
  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const localFileName = `${timestamp}_${safeName}`;
  const localFilePath = path.join(uploadsDir, localFileName);
  fs.writeFileSync(localFilePath, file.buffer);

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
