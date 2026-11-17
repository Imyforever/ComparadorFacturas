# AGENTS.md — Comparador de Facturas

Concilia facturas del SAT (reporte "Consulta CFDI" en PDF) contra estados de cuenta bancarios (BBVA, Scotiabank; PDF, CSV o Excel exportado como texto). Una factura queda **Pagada** cuando un **Retiro** del banco coincide en importe (tolerancia < 5 centavos), con desempate por RFC, nombre del proveedor y cercanía de fechas. Hay pestañas por **entidad** (cuenta: "Personal", "Empresa"...) y por **periodo** (`AAAA-MM`). También hay enlaces manuales, notas de crédito (Egreso) aplicadas a facturas, facturas capturadas a mano y exportación a CSV.

Stack: Node 24 (CommonJS), Express 4, Mongoose 8 (MongoDB Atlas), multer (subidas en memoria), pdf-parse 2, Cloudflare R2 opcional. Frontend: HTML + CSS + JS vanilla sin build (`public/`).

## Comandos
- `npm run verify` — revisa la sintaxis de todos los .js y corre `node --test` sobre `test/**/*.test.js`. **Debe pasar antes de entregar.**
- `npm start` — servidor en http://localhost:3000 (requiere MONGODB_URI en .env para las rutas de conciliación).

## Arquitectura objetivo (SOLID)
```
server.js                  Solo arranque: crea la app (src/app.js) y escucha el puerto.
src/app.js                 Construye la app Express (middlewares, rutas, errores). Exportable para pruebas.
src/config/                Configuración (env, db, r2). Leer process.env SOLO aquí.
src/models/                Esquemas Mongoose (sin lógica de negocio).
src/middleware/            auth (verifica token), requireDatabase, errorHandler.
src/routes/                Delgadas: validan entrada, llaman a un servicio y responden. Nada de lógica de negocio ni consultas complejas.
src/services/              Lógica de negocio (conciliación, enlaces manuales, egresos, pestañas, exportación CSV, autenticación).
src/repositories/          Acceso a datos Mongoose (consultas y bulkWrite). Los servicios dependen de estos, no de los modelos directamente.
src/parsers/               Un archivo por formato (sat/cfdiReport.js, bbva/*.js, scotiabank/*.js, csv.js) + registry.js que detecta el formato.
src/utils/                 Funciones puras compartidas (dates, money, text, csv).
test/                      node:test. Funciones puras con pruebas unitarias; servicios con repositorios falsos inyectados.
```
Principios:
- **S**: un módulo = una responsabilidad. Ningún archivo de `src/` > ~300 líneas.
- **O**: nuevo banco/formato = nuevo archivo en `src/parsers/` registrado en `registry.js` (cada parser expone `{ id, canParse(text, fileName), parse(text, defaultYear) }`), sin tocar los demás.
- **L**: todos los parsers devuelven la misma forma de resultado (ver "Contratos").
- **I**: módulos exportan funciones pequeñas y específicas.
- **D**: servicios reciben sus dependencias (repositorios, reloj) por parámetro/fábrica para poder probarlos sin MongoDB.

## Reglas
- **No cambiar el comportamiento observable** (respuestas JSON, códigos HTTP, rutas, campos de BD) salvo lo pedido en la tarea. Las pruebas de `test/` fijan el comportamiento: si una cambia, debe ser una corrección intencional y explicada.
- **Dinero en centavos enteros** para comparar/sumar (`Math.round(x*100)`); nunca comparar floats directamente.
- Fechas: usar `src/utils/dates` (`parseFlexibleDate`, `resolveYearForMonth`). No usar `new Date(string)` con formatos locales.
- Nada de secretos en código. `process.env` solo en `src/config/`.
- Comentarios y mensajes al usuario en español, sin emojis.
- No agregar dependencias de npm salvo que la tarea lo pida.
- No borrar datos de usuario ni cambiar nombres de colecciones/campos de Mongo.

## Contratos
- Movimiento bancario: `{ fecha:'DD-MES-YYYY', fechaNormalizada?, concepto, monto:Number>0, tipo:'Retiro'|'Deposito', banco, rfcDetectado?, origenReferencia? }`.
- Resultado de parser bancario: `{ banco, tipoDocumento, periodo?, movimientos:[...], ... }` (ver `finalizeStatement`).
- Auth: `POST /api/auth/login` devuelve `token` (JWT HS256). Todas las rutas `/api/*` excepto `/api/auth/login` y `/api/health` exigen `Authorization: Bearer <token>`; si falta o es inválido → 401 `{ success:false, message }`. El frontend guarda el token en `localStorage.auth_token` y ante 401 manda al login.

## Estética (frontend)
Estilo sobrio tipo Excel/Office ya existente en `public/css/styles.css`. No rediseñar: mantener el aspecto actual.

## Protocolo de progreso
Escribe y actualiza el archivo de progreso indicado en el prompt con:
`{"percent": <0-100>, "step": "<qué haces ahora>", "done": <true|false>}`
Actualízalo al terminar cada paso grande. Al final `percent:100, done:true`.

## Entrega
Al terminar, responde con: archivos creados/cambiados, cambios de comportamiento intencionales (si hay), resultado de `npm run verify` y pendientes.
