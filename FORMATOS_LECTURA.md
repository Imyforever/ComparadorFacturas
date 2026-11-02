# Catálogo de Formatos de Archivos y Reglas de Lectura

Este documento describe **únicamente los tipos de formatos de archivos soportados** por el sistema y la manera exacta en que el motor de lectura (`cfdiParser.js` y `bankParser.js`) los identifica, extrae y normaliza para su visualización y conciliación.

---

## 1. Facturas Recibidas del SAT (Consulta CFDI - PDF)
- **Módulo Lector**: `src/services/cfdiParser.js` -> `parseCfdiReport()`
- **Tipo de Archivo**: `.pdf` (Reporte oficial de Consulta CFDI descargado del portal del SAT).
- **Cómo lo detecta**:
  - Divide el texto extraído del PDF en bloques tomando como delimitador la etiqueta `Folio Fiscal:`.
- **Cómo extrae los datos**:
  - **UUID (`uuid`)**: Primeros 36 caracteres hexadecimales con guiones tras `Folio Fiscal:`.
  - **RFC y Nombre del Emisor (`rfcEmisor`, `emisor`)**: Expresión regular sobre `RFC Emisor: <RFC> Nombre o Razón Social: <Nombre>`.
  - **Fecha de Emisión y Periodo (`fechaEmision`, `periodo`)**: Extrae `Fecha Emisión: YYYY-MM-DDTHH:mm:ss` y toma los primeros 7 caracteres (`YYYY-MM`) para validar que corresponda al mes seleccionado.
  - **Total (`total`)**: Extrae el importe tras `Total: $X,XXX.XX`. *(Nota: las facturas menores a $50.00 se contabilizan en el cuadro de resumen "Menores a $50" y se ocultan de las tablas principales).*
  - **Estado SAT (`estadoSat`)**: Lee `Estado del Comprobante:` (`Vigente` o `Cancelado`).
  - **Efecto (`efecto`)**: Lee `Efecto del Comprobante:` (`Ingreso`, `Egreso`, `Pago`, `Nomina`).

---

## 2. BBVA Estado de Cuenta Oficial (Cheques / Débito / Maestra PyME / Centralizadora - PDF)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseBBVAStatement()`
- **Tipo de Archivo**: `.pdf`
- **Cómo lo detecta**:
  - Presencia de `BBVA`, `MAESTRA PYME` o `CENTRALIZADORA` en el encabezado, o filas que inician con doble fecha en formato `DD/MES DD/MES` (ej. `01/SEP 01/SEP`).
- **Cómo extrae los datos**:
  - **Año y Cuenta**: Extrae el año de `Fecha de Corte DD/MM/YYYY` o `Periodo DEL DD/MM/YYYY`, y la cuenta de `No. de Cuenta <dígitos>`.
  - **Estructura de fila**: `DD/MES DD/MES [CÓDIGO_3_CARACTERES] DESCRIPCIÓN IMPORTE [SALDO]`.
  - **Clasificación Cargo (`Retiro`) vs Abono (`Deposito`)**:
    - Verifica si el código de operación pertenece al catálogo de cargos BBVA (`A15`, `I73`, `I74`, `K08`, `K64`, `K65`, `P14`, `P31`, `R01`, `S39`, `S40`, `T17`, `V43`, `V44`, `V46`, `V47`, `X01`).
    - Para código `N06` (Pago cuenta de tercero) evalúa el concepto, o busca palabras clave como `SPEI ENVIADO`, `PAGO DE NOMINA`, `IMSS`, `COM.`, `IVA TASA`.
  - **RFC Detectado (`rfcDetectado`)**: Busca patrones `RFC: <RFC>`, `Ref. <RFC>` o estructura de RFC mexicano en las líneas de detalle del movimiento.

---

## 3. BBVA Detalle de Movimientos (Portal Web / Cash Management - PDF)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseBBVADetalleMovimientos()`
- **Tipo de Archivo**: `.pdf`
- **Cómo lo detecta**:
  - Contiene las frases `Detalle de movimientos` y `Cuenta con / sin chequera` en los primeros 800 caracteres del documento.
- **Cómo extrae los datos**:
  - **Cuenta**: Extrae los dígitos tras `Número de cuenta:`.
  - **Estructura de bloque**: Agrupa bloques que inician con fecha corta `DD-MM` al principio de línea.
  - **Importe y Saldo**: Captura todos los montos con signo `$` en el bloque; el primero corresponde al `monto` del movimiento y el último al `saldo`.
  - **Clasificación Cargo (`Retiro`) vs Abono (`Deposito`)**:
    - Como el reporte web viene ordenado del movimiento más reciente al más antiguo, compara el `saldo` actual contra el `saldo` del movimiento inmediato anterior (`i + 1`). Si el saldo disminuyó (`saldo < prevSaldo`), lo registra como `Retiro` (Cargo); si aumentó, como `Deposito` (Abono).

---

## 4. BBVA Tarjeta de Crédito / Tarjeta Negocios / Línea de Crédito Digital PyME (PDF)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseBBVACreditOrCardStatement()`
- **Tipo de Archivo**: `.pdf`
- **Cómo lo detecta**:
  - Contiene `Línea Crédito Digital PyME`, `T Negoc`, `LCDigital` o `Movimientos Efectuados Crédito / Tarjeta Titular` junto con `BBVA`.
- **Cómo extrae los datos**:
  - **Banco y Cuenta**: Asigna `BBVA (Línea Crédito PyME)` o `BBVA (Tarjeta Negocios)` y toma los últimos 4 dígitos de `No. de Crédito`, `No. de Tarjeta` o `Cuenta CLABE`.
  - **Estructura de fila**: `FECHA_AUT (DD/MM/YY) FECHA_APL (DD/MM/YY) CONCEPTO [RFC] [REFERENCIA] [CARGOS] [ABONOS]`.
    - Ejemplo: `03/09/26 04/09/26 FERRE ABAS MAX CHETUM AMA 0512139J5 ******9851 $ 2,177.99`
  - **Concepto, Referencia y RFC**:
    - Separa los importes del final de la línea.
    - Extrae la referencia enmascarada (ej. `******9851`).
    - Detecta y separa el RFC del comercio al final del concepto (ej. `AMA 0512139J5` -> `AMA0512139J5`).
  - **Clasificación Cargo (`Retiro`) vs Abono (`Deposito`)**:
    - Si vienen dos columnas de importe (`CARGOS` y `ABONOS`), es `Retiro` cuando la primera es mayor a 0.
    - Si viene un solo importe, es `Retiro` salvo que el concepto indique `PAGO`, `ABONO`, `DEVOLUCIÓN`, `REEMBOLSO` o `BONIFICACIÓN`.

---

## 5. Scotiabank Estado de Cuenta Débito / Cheques Tradicional (PDF)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseScotiabankStatement()`
- **Tipo de Archivo**: `.pdf`
- **Cómo lo detecta**:
  - Formato PDF de Scotiabank con bloques de movimientos que inician con `DD MES` (ej. `15 SEP`).
- **Cómo extrae los datos**:
  - **Año y Cuenta**: Toma el año de `Periodo DD-MES-YY` y el número de cuenta de `Cuenta <dígitos>`.
  - **Importe y Saldo**: De cada bloque con fecha `DD MES`, extrae los valores con `$`: el primer monto es el `monto` de la operación y el último es el `saldo` resultante.
  - **Clasificación Cargo (`Retiro`) vs Abono (`Deposito`)**:
    - Calcula la progresión aritmética respecto al `prevSaldo`: si `prevSaldo - monto ≈ saldo`, es `Retiro` (Cargo); si `prevSaldo + monto ≈ saldo`, es `Deposito` (Abono).
  - **RFC Detectado (`rfcDetectado`)**: Busca el patrón `RFC <RFC>` dentro del concepto del movimiento.

---

## 6. Scotiabank Tarjeta de Crédito - Scotia Travel / Scotia Rewards (PDF)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseScotiabankCreditCardStatement()`
- **Tipo de Archivo**: `.pdf`
- **Cómo lo detecta**:
  - Presencia de `Scotia Travel`, `Scotia Rewards`, `Tarjeta de Crédito Scotiabank`, `CARGOS, ABONOS Y COMPRAS REGULARES`, o renglones con doble fecha `DD-mes-YYYY DD-mes-YYYY` e importe con signo `+` o `-`.
- **Cómo extrae los datos**:
  - **Cuenta**: Extrae los últimos 4 dígitos de `No. Tarjeta` / `Tarjeta titular`.
  - **Estructura de fila**: `DD-mes-YYYY (Fecha Operación) DD-mes-YYYY (Fecha Cargo) DESCRIPCIÓN [+|-] $IMPORTE`.
  - **Clasificación Cargo (`Retiro`) vs Abono (`Deposito`)**:
    - En tarjetas de crédito Scotiabank, los consumos/cargos vienen precedidos por el signo `+` (se clasifican como `Retiro` para conciliar contra facturas de gastos) y los pagos/abonos a la tarjeta vienen con signo `-` (`Deposito`).

---

## 7. Scotiabank Movimientos en Formato Excel / CSV (ScotiaWeb / Exportación CSV)
- **Módulo Lector**: `src/services/bankParser.js` -> `parseCsvOrExcelBankStatement()`
- **Tipo de Archivo**: `.csv`, `.txt`, `.xls`, `.xlsx` (Archivo separado por comas exportado de banca electrónica Scotiabank).
- **Cómo lo detecta**:
  - Verifica si el archivo no tiene cabecera binaria `%PDF` o tiene extensión `.csv`/`.txt`/`.xls`/`.xlsx`, y valida que contenga el encabezado de columnas `Tipo,Moneda,Uso futuro,Cuenta,Fecha,Referencia,Importe,Tipo(Cargo/Abono)...` o filas que inicien con `CHQ,MXN,`.
- **Cómo extrae los datos**:
  - **Fila 1 (Resumen de cabecera opcional)**:
    - Ejemplo: `502424129,25601064912,DZUL CHAZARRETA CLAUDIO AARON,MXN,2026/10/28,47,44977.73,115,43314.12,162`
    - Extrae automáticamente el número de cuenta de la columna 2 (`25601064912`).
  - **Fila 2 (Encabezado de 15 columnas)**:
    - `Tipo,Moneda,Uso futuro,Cuenta,Fecha,Referencia,Importe,Tipo(Cargo/Abono),Saldo,Transacción,Leyenda 1,Leyenda 2,Leyenda 3,Información adicional SPEI/SPID,Consecutivo`
  - **Mapeo de columnas por cada movimiento**:
    - **Columna 4 (`Cuenta`)**: Número de cuenta eliminando ceros a la izquierda (`00000025601064912` -> `25601064912`).
    - **Columna 5 (`Fecha`)**: Soporta `YYYY/MM/DD` (ej. `2026/10/28`) y `DD/MM/YYYY`, convirtiéndola al periodo `YYYY-MM` (`2026-10`) y formato visual `DD-MES-YYYY` (`28-OCT-2026`).
    - **Columna 6 (`Referencia`)**: Se guarda como `origenReferencia` (eliminando ceros a la izquierda).
    - **Columna 7 (`Importe`)**: Monto numérico del movimiento (`monto`).
    - **Columna 8 (`Tipo(Cargo/Abono)`)**: Si dice `Cargo` se registra como `Retiro` (para conciliación contra facturas del SAT); si dice `Abono` se registra como `Deposito`.
    - **Columna 9 (`Saldo`)**: Saldo posterior al movimiento (`saldo`).
    - **Columnas 10 a 14 (`Transacción`, `Leyenda 1`, `Leyenda 2`, `Leyenda 3`, `Información adicional SPEI/SPID`)**: Se unen con ` | ` para formar el `concepto` completo (ej. `BODEGA CHETUMAL NORTE | BODEGA CHETUMAL NORTE\ | REF. 0029124613 AUT. 562514 | RFC NWM 9709244W4`).
    - **Extracción automática de RFC (`rfcDetectado`)**: Analiza las leyendas (especialmente `Leyenda 3`, donde Scotiabank coloca `RFC NWM 9709244W4` o `RFC PLA 120807BK0`) y normaliza el RFC sin espacios (`NWM9709244W4`, `PLA120807BK0`) para vincular automáticamente el cargo con las facturas del proveedor en el SAT.

