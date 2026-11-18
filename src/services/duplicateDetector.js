/**
 * Deteccion pura de movimientos bancarios duplicados entre archivos distintos de la misma entidad y cuenta.
 * Dos movimientos son el mismo cuando coinciden fecha, tipo, monto (centavos), cuenta y, si ambos saldos
 * son mayores a 0, tambien el saldo. Nunca se compara contra el mismo archivo (cargos identicos el mismo dia
 * son legitimos) y cada movimiento existente solo puede ser "duplicado de" una vez por archivo.
 */

const { toCents } = require('../utils/money');

const dupKey = (m) => [m.fecha || '', m.tipo || '', toCents(m.monto), String(m.cuenta || '')].join('|');

const bothHaveSaldo = (a, b) => toCents(a.saldo) > 0 && toCents(b.saldo) > 0;
const saldoCompatible = (a, b) => !bothHaveSaldo(a, b) || toCents(a.saldo) === toCents(b.saldo);
const saldoEqualStrict = (a, b) => bothHaveSaldo(a, b) && toCents(a.saldo) === toCents(b.saldo);

const isReserved = (m) => Boolean(m.conciliado || m.facturaUuid);

/**
 * Marca cuales movimientos de un archivo recien leido ya existen en otros archivos.
 * @param {Array<Object>} newMovements - movimientos del archivo que se sube
 * @param {Array<Object>} existingMovements - movimientos de OTROS archivos (misma entidad), sin duplicadoDe
 * @returns {Array<string|null>} por cada movimiento nuevo, el _id del existente del que es duplicado (o null)
 */
const findDuplicatesOfExisting = (newMovements = [], existingMovements = []) => {
  const buckets = new Map();
  for (const e of existingMovements) {
    if (!e || e.duplicadoDe) continue;
    const key = dupKey(e);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const result = new Array(newMovements.length).fill(null);
  const claimed = new Set();
  const pass = (matches) => {
    newMovements.forEach((m, idx) => {
      if (result[idx]) return;
      const found = (buckets.get(dupKey(m)) || []).find((e) => !claimed.has(String(e._id)) && matches(m, e));
      if (found) {
        claimed.add(String(found._id));
        result[idx] = found._id;
      }
    });
  };
  // Primero los que coinciden tambien en saldo; despues los que no tienen saldo comparable
  pass(saldoEqualStrict);
  pass(saldoCompatible);
  return result;
};

/**
 * Planea marcas de duplicadoDe sobre movimientos ya guardados (todos de una entidad).
 * Conserva el del archivo cuyo archivoPeriodo == periodo del movimiento; si el que se marcaria esta conciliado
 * y el otro no, se marca al reves; si ambos estan conciliados se reporta sin tocar.
 * @returns {{ marks: Array<{ _id: any, duplicadoDe: any }>, conflicts: Array<{ ids: any[] }> }}
 */
const planDuplicateMarks = (movements = []) => {
  const groups = new Map();
  for (const m of movements) {
    if (!m || m.duplicadoDe || !m.archivoOrigen) continue;
    const key = dupKey(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const preference = (m) => (m.archivoPeriodo && m.archivoPeriodo === m.periodo ? 0 : 1);
  const marks = [];
  const conflicts = [];

  for (const members of groups.values()) {
    if (new Set(members.map((m) => m.archivoOrigen)).size < 2) continue;
    const ranked = [...members].sort(
      (a, b) => preference(a) - preference(b) || String(a._id).localeCompare(String(b._id))
    );
    const claimed = new Set();

    for (const keeper of ranked) {
      if (claimed.has(String(keeper._id))) continue;
      claimed.add(String(keeper._id));
      const cluster = [keeper];
      const files = new Set([keeper.archivoOrigen]);

      for (const matches of [saldoEqualStrict, saldoCompatible]) {
        for (const other of ranked) {
          if (claimed.has(String(other._id)) || files.has(other.archivoOrigen)) continue;
          if (!matches(keeper, other)) continue;
          claimed.add(String(other._id));
          files.add(other.archivoOrigen);
          cluster.push(other);
        }
      }
      if (cluster.length < 2) continue;

      const reserved = cluster.filter(isReserved);
      const survivor = reserved.length > 0 && !isReserved(keeper) ? reserved[0] : keeper;
      const extraReserved = reserved.filter((m) => m !== survivor);
      for (const m of cluster) {
        if (m === survivor) continue;
        if (extraReserved.includes(m)) continue;
        marks.push({ _id: m._id, duplicadoDe: survivor._id });
      }
      if (extraReserved.length > 0) conflicts.push({ ids: [survivor._id, ...extraReserved.map((m) => m._id)] });
    }
  }
  return { marks, conflicts };
};

module.exports = { dupKey, findDuplicatesOfExisting, planDuplicateMarks };
