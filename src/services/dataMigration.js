/**
 * Planeacion pura (sin base de datos) de la migracion de datos de noviembre 2026:
 *   a. Movimientos de "Personal" cuyo archivo tambien existe en otra entidad pasan a esa entidad.
 *   b. Limpieza de conceptos con cleanBankConcept (y rfcDetectado si el concepto cambio).
 *   c. Marcado de duplicadoDe entre archivos distintos de la misma entidad.
 * Todo es idempotente: volver a planear sobre los datos ya migrados no produce cambios.
 */

const { cleanBankConcept, detectRfcInConcept } = require('../utils/text');
const { findDuplicatesOfExisting, planDuplicateMarks } = require('./duplicateDetector');

const SOURCE_ENTIDAD = 'Personal';

const isReserved = (m) => Boolean(m.conciliado || m.facturaUuid);

/** a. Mueve a su entidad real los movimientos de "Personal" cuyo archivo existe tambien en otra entidad */
const planEntityMoves = (movements, source = SOURCE_ENTIDAD) => {
  const entitiesByFile = new Map();
  for (const m of movements) {
    if (!m.archivoOrigen) continue;
    if (!entitiesByFile.has(m.archivoOrigen)) entitiesByFile.set(m.archivoOrigen, new Set());
    entitiesByFile.get(m.archivoOrigen).add(m.entidad);
  }

  const sourceByFile = new Map();
  for (const m of movements) {
    if (m.entidad !== source || !m.archivoOrigen) continue;
    if (!sourceByFile.has(m.archivoOrigen)) sourceByFile.set(m.archivoOrigen, []);
    sourceByFile.get(m.archivoOrigen).push(m);
  }

  const moves = [];
  const ambiguous = [];
  for (const [archivoOrigen, list] of sourceByFile) {
    const others = [...entitiesByFile.get(archivoOrigen)].filter((e) => e && e !== source).sort();
    if (others.length === 0) continue;
    if (others.length > 1) {
      ambiguous.push({ archivoOrigen, entidades: others, count: list.length });
      continue;
    }
    moves.push({ archivoOrigen, to: others[0], movements: list });
  }
  return { moves, ambiguous };
};

/** b. Conceptos que cambian al limpiarlos (con su rfcDetectado recalculado solo si el RFC ya no aparece) */
const planConceptCleanups = (movements) => {
  const changes = [];
  for (const m of movements) {
    const cleaned = cleanBankConcept(m.concepto);
    if (!m.concepto || cleaned === m.concepto || !cleaned) continue;
    const set = { concepto: cleaned };
    const rfc = String(m.rfcDetectado || '').toUpperCase();
    if (rfc && !cleaned.toUpperCase().replace(/\s+/g, '').includes(rfc)) {
      set.rfcDetectado = detectRfcInConcept(cleaned);
    }
    changes.push({ _id: m._id, set });
  }
  return changes;
};

/**
 * Plan completo. `movements` son documentos planos (lean) de TODAS las entidades.
 * @returns {{ ops: Array<{_id:any, set:Object}>, summary: Object }}
 */
const buildMigrationPlan = (movements = []) => {
  const setById = new Map();
  const addSet = (id, fields) => setById.set(String(id), { _id: id, set: { ...(setById.get(String(id))?.set || {}), ...fields } });

  // a. Cambios de entidad
  const { moves, ambiguous } = planEntityMoves(movements);
  const working = new Map(movements.map((m) => [String(m._id), { ...m }]));
  const movedIds = new Set();
  const scopes = new Map();
  let movedCount = 0;
  let movedDuplicates = 0;

  for (const move of moves) {
    for (const m of move.movements) {
      addSet(m._id, { entidad: move.to });
      working.get(String(m._id)).entidad = move.to;
      movedIds.add(String(m._id));
      movedCount++;
      for (const p of [m.periodo, m.archivoPeriodo]) {
        if (p) {
          scopes.set(`${p}|${m.entidad}`, { periodo: p, entidad: m.entidad });
          scopes.set(`${p}|${move.to}`, { periodo: p, entidad: move.to });
        }
      }
    }
    // Si la entidad destino ya tenia el mismo movimiento (aunque sea del mismo archivo), no se cuenta doble
    const pool = [...working.values()].filter(
      (m) => m.entidad === move.to && !movedIds.has(String(m._id)) && !m.duplicadoDe
    );
    const free = move.movements.filter((m) => !isReserved(m) && !m.duplicadoDe);
    const dupOf = findDuplicatesOfExisting(free, pool);
    free.forEach((m, idx) => {
      if (!dupOf[idx]) return;
      addSet(m._id, { duplicadoDe: dupOf[idx] });
      working.get(String(m._id)).duplicadoDe = dupOf[idx];
      movedDuplicates++;
    });
  }

  // b. Conceptos
  const conceptChanges = planConceptCleanups([...working.values()]);
  for (const c of conceptChanges) {
    addSet(c._id, c.set);
    Object.assign(working.get(String(c._id)), c.set);
  }

  // c. Duplicados entre archivos (por entidad, sobre el estado ya migrado)
  const byEntity = new Map();
  for (const m of working.values()) {
    if (!byEntity.has(m.entidad)) byEntity.set(m.entidad, []);
    byEntity.get(m.entidad).push(m);
  }
  let duplicateMarks = 0;
  const conflicts = [];
  for (const [entidad, list] of byEntity) {
    const { marks, conflicts: c } = planDuplicateMarks(list);
    for (const mark of marks) {
      addSet(mark._id, { duplicadoDe: mark.duplicadoDe });
      duplicateMarks++;
    }
    conflicts.push(...c.map((x) => ({ entidad, ids: x.ids })));
  }

  return {
    ops: [...setById.values()],
    summary: {
      movimientosMovidos: movedCount,
      movimientosMovidosComoDuplicado: movedDuplicates,
      movimientosMovidosPorArchivo: moves.map((m) => ({
        archivoOrigen: m.archivoOrigen,
        destino: m.to,
        movimientos: m.movements.length
      })),
      archivosAmbiguos: ambiguous,
      conceptosLimpiados: conceptChanges.length,
      rfcRecalculados: conceptChanges.filter((c) => 'rfcDetectado' in c.set).length,
      duplicadosMarcados: duplicateMarks,
      conflictosDuplicados: conflicts,
      alcancesARecalcular: [...scopes.values()]
    }
  };
};

module.exports = { planEntityMoves, planConceptCleanups, buildMigrationPlan };
