/**
 * Migracion de datos 2026-11 (idempotente).
 *
 *   node scripts/migrar-datos-2026-11.js            -> SOLO simula e imprime el plan
 *   node scripts/migrar-datos-2026-11.js --apply    -> escribe los cambios en MongoDB
 *
 * Cambios:
 *   a. Movimientos de "Personal" cuyo archivoOrigen existe tambien en otra entidad pasan a esa entidad.
 *   b. Se aplica cleanBankConcept a los conceptos existentes (y se recalcula rfcDetectado si ya no aparece).
 *   c. Se marca duplicadoDe en movimientos duplicados entre archivos distintos de la misma entidad
 *      (se conserva el del archivo cuyo archivoPeriodo coincide con el periodo del movimiento; si el que se
 *      marcaria esta conciliado se marca el otro; si ambos lo estan solo se reporta).
 * Usa la misma configuracion (.env) y conexion que la app. No borra nada.
 */

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const bankMovementRepo = require('../src/repositories/bankMovementRepository');
const { buildMigrationPlan } = require('../src/services/dataMigration');

const BATCH_SIZE = 500;
const PROJECTION = {
  entidad: 1,
  periodo: 1,
  archivoOrigen: 1,
  archivoPeriodo: 1,
  concepto: 1,
  rfcDetectado: 1,
  conciliado: 1,
  facturaUuid: 1,
  fecha: 1,
  tipo: 1,
  monto: 1,
  saldo: 1,
  cuenta: 1,
  duplicadoDe: 1
};

const printSummary = (summary, apply) => {
  console.log(`\n=== Resumen (${apply ? 'APLICADO' : 'SIMULACION, no se escribio nada'}) ===`);
  console.log(`a. Movimientos movidos de entidad: ${summary.movimientosMovidos}`);
  for (const m of summary.movimientosMovidosPorArchivo) {
    console.log(`   - "${m.archivoOrigen}" -> ${m.destino}: ${m.movimientos}`);
  }
  console.log(`   (de ellos marcados duplicadoDe por existir ya en la entidad destino: ${summary.movimientosMovidosComoDuplicado})`);
  for (const a of summary.archivosAmbiguos) {
    console.log(`   ! Archivo en varias entidades, no se movio: "${a.archivoOrigen}" (${a.entidades.join(', ')}) - ${a.count} mov.`);
  }
  console.log(`b. Conceptos limpiados: ${summary.conceptosLimpiados} (rfcDetectado recalculado: ${summary.rfcRecalculados})`);
  console.log(`c. Duplicados marcados (duplicadoDe): ${summary.duplicadosMarcados}`);
  for (const c of summary.conflictosDuplicados) {
    console.log(`   ! Duplicados ya conciliados, sin tocar (${c.entidad}): ${c.ids.join(', ')}`);
  }
  if (summary.alcancesARecalcular.length > 0) {
    console.log('\nRecalcule la conciliacion (boton Recalcular / POST /api/reconciliation/refresh) en:');
    for (const s of summary.alcancesARecalcular) console.log(`   - ${s.periodo} / ${s.entidad}`);
  }
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error('No hay conexion a MongoDB (revise MONGODB_URI en .env). No se hizo nada.');
    process.exitCode = 1;
    return;
  }

  const movements = await bankMovementRepo.findAll({}, PROJECTION);
  console.log(`Movimientos leidos: ${movements.length}`);

  const { ops, summary } = buildMigrationPlan(movements);
  printSummary(summary, apply);
  console.log(`\nMovimientos con cambios: ${ops.length}`);

  if (!apply) {
    console.log('Simulacion terminada. Use --apply para escribir los cambios.');
    return;
  }

  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = ops.slice(i, i + BATCH_SIZE).map((op) => ({
      updateOne: { filter: { _id: op._id }, update: { $set: op.set } }
    }));
    await bankMovementRepo.bulkWrite(batch);
  }
  console.log('Cambios aplicados.');
};

main()
  .catch((err) => {
    console.error(`Error en la migracion: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
