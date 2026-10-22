# Comparador de Facturas (Node.js + MongoDB + Cloudflare R2)

Plataforma de auditoria y conciliacion de facturas electronicas con backend en Node.js, base de datos en MongoDB y almacenamiento de archivos PDF en Cloudflare R2.

---

## Arquitectura de Produccion (Opcion 1)

* **Servidor Web y API**: Node.js + Express (Desplegable en Render o Railway).
* **Base de Datos**: MongoDB Atlas (Esquema JSON para facturas y usuarios).
* **Almacenamiento de PDFs**: Cloudflare R2 (Compatible con S3, 10 GB gratis y 0 costo de transferencia).
* **Seguridad y Dominio**: Cloudflare (DNS, SSL HTTPS automatico y firewall).

---

## Estructura del Proyecto

```text
ComparadorFacturas/
├── .env                       # Variables de entorno y configuracion
├── package.json               # Dependencias (express, mongoose, multer, @aws-sdk/client-s3)
├── server.js                  # Servidor central Express y enrutador
├── uploads/                   # Carpeta de almacenamiento local (fallback si no hay R2)
├── src/
│   ├── config/
│   │   ├── db.js              # Conexion a MongoDB Atlas
│   │   └── r2.js              # Cliente de Cloudflare R2 (S3-compatible)
│   ├── models/
│   │   ├── Invoice.js         # Modelo de datos de factura (Mongoose)
│   │   └── User.js            # Modelo de usuario administrador
│   └── routes/
│       └── invoices.js        # Rutas para subida de PDFs y consulta de facturas
└── public/
    ├── html/
    │   ├── index.html         # Pantalla de Login (estilo Excel/Office, sin registro)
    │   └── dashboard.html     # Panel de facturas y cargador de PDFs
    ├── css/
    │   └── styles.css         # Hoja de estilos sobria y limpia
    └── js/
        ├── login.js           # Validacion y sesion de usuario
        └── dashboard.js       # Listado dinamico y subida de PDFs
```

---

## Configuracion para Produccion (.env)

Copia o edita tu archivo `.env`:

```env
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin

# 1. MongoDB Atlas:
# Obten tu URI en https://cloud.mongodb.com -> Connect -> Drivers
MONGODB_URI=mongodb+srv://usuario:password@cluster0.xxxxx.mongodb.net/comparador_facturas?retryWrites=true&w=majority

# 2. Cloudflare R2 (Para guardar los PDFs):
# En Cloudflare -> R2 Object Storage -> Manage R2 API Tokens
R2_ACCOUNT_ID=tu_account_id_de_cloudflare
R2_ACCESS_KEY_ID=tu_access_key_r2
R2_SECRET_ACCESS_KEY=tu_secret_key_r2
R2_BUCKET_NAME=facturas-pdfs
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
```

> **Nota:** Si ejecutas el proyecto localmente sin configurar MongoDB o Cloudflare R2 aun, el servidor automaticamente usa almacenamiento local en `/uploads` y memoria temporal para que puedas probar la subida de PDFs sin interrupciones.

---

## Puesta en Marcha

```bash
# Iniciar servidor
npm start
```

* **Login**: [http://localhost:3000/](http://localhost:3000/)
* **Dashboard**: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
* **Credenciales de acceso**: Usuario `admin` / Contrasena `admin` (hasheada en base de datos)
