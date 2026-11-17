/**
 * Logica de busqueda, normalizacion, analisis de campos y filtrado de facturas.
 */

import { formatMoney, toCents, fromCents } from './format.js';

export const FIELD_LABELS = {
  emisor: 'Proveedor',
  rfcEmisor: 'RFC',
  uuid: 'UUID',
  estadoPago: 'Estado',
  banco: 'Banco',
  observaciones: 'Notas',
  all: 'Todos'
};

export function normalizeStr(str) {
  if (!str) return '';
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function matchesQuery(targetVal, query) {
  if (!query) return true;
  if (!targetVal) return false;

  const normTarget = normalizeStr(targetVal);
  const normQuery = normalizeStr(query);

  if (normTarget.includes(normQuery)) return true;

  const compactTarget = normTarget.replace(/[^a-z0-9]/g, '');
  const compactQuery = normQuery.replace(/[^a-z0-9]/g, '');
  if (compactQuery && compactTarget.includes(compactQuery)) return true;

  const tokens = normQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => normTarget.includes(tok))) {
    return true;
  }

  return false;
}

export function checkFieldMatch(inv, field, query) {
  if (!query) return true;
  switch (field) {
    case 'emisor':
      return matchesQuery(inv.emisor, query);
    case 'rfcEmisor':
      return matchesQuery(inv.rfcEmisor, query);
    case 'uuid':
      return matchesQuery(inv.uuid, query);
    case 'estadoPago':
      return matchesQuery(inv.estadoPago, query);
    case 'banco': {
      const bancoInfo = `${inv.pagoAsociado?.banco || ''} ${inv.pagoAsociado?.conceptoBanco || ''} ${inv.estadoPago === 'Pagada' ? 'Pagada' : ''}`;
      return matchesQuery(bancoInfo, query);
    }
    case 'observaciones':
      return matchesQuery(inv.observaciones, query);
    case 'all':
    default: {
      const allText = `${inv.uuid || ''} ${inv.emisor || ''} ${inv.rfcEmisor || ''} ${inv.total || ''} ${inv.estadoPago || ''} ${inv.pagoAsociado?.banco || ''} ${inv.observaciones || ''}`;
      return matchesQuery(allText, query);
    }
  }
}

export function getAnalyzedFieldValues(invoices, field) {
  const map = new Map();

  for (const inv of invoices) {
    if (toCents(inv.total) < 10000) continue;
    let key = '';
    let secondary = '';

    if (field === 'emisor') {
      key = (inv.emisor || 'Sin Emisor').trim();
      secondary = inv.rfcEmisor || '';
    } else if (field === 'rfcEmisor') {
      key = (inv.rfcEmisor || 'Sin RFC').trim();
      secondary = inv.emisor || '';
    } else if (field === 'uuid') {
      key = (inv.uuid || '').trim();
    } else if (field === 'estadoPago') {
      key = (inv.estadoPago || 'No Pagada').trim();
    } else if (field === 'banco') {
      key = (inv.pagoAsociado?.banco || (inv.estadoPago === 'Pagada' ? 'Banco Conciliado' : 'Sin pago bancario')).trim();
    } else if (field === 'observaciones') {
      if (!inv.observaciones) continue;
      key = inv.observaciones.trim();
    } else {
      key = (inv.emisor || 'Sin Emisor').trim();
      secondary = inv.rfcEmisor || '';
    }

    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        name: key,
        secondary,
        count: 0,
        totalCents: 0,
        pagadasCount: 0,
        pagadasCents: 0,
        noPagadasCount: 0,
        noPagadasCents: 0,
        canceladasCount: 0
      });
    }

    const item = map.get(key);
    const montoCents = toCents(inv.total);
    item.count++;
    item.totalCents += montoCents;

    if (inv.estadoPago === 'Pagada') {
      item.pagadasCount++;
      item.pagadasCents += montoCents;
    } else if (inv.estadoPago === 'No Pagada') {
      item.noPagadasCount++;
      item.noPagadasCents += montoCents;
    } else if (inv.estadoPago === 'Cancelada') {
      item.canceladasCount++;
    }
  }

  return Array.from(map.values())
    .map((item) => ({
      ...item,
      total: fromCents(item.totalCents),
      pagadasMonto: fromCents(item.pagadasCents),
      noPagadasMonto: fromCents(item.noPagadasCents)
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function updateAnalyzedOptions(els, invoices, selectedField) {
  const list = getAnalyzedFieldValues(invoices, selectedField);
  const fieldName = FIELD_LABELS[selectedField] || 'Campo';

  if (els.labelAnalyzedSelect) {
    els.labelAnalyzedSelect.textContent = `${fieldName}s (${list.length}):`;
  }
  if (els.labelSearchInput) {
    els.labelSearchInput.textContent = 'Buscar:';
  }

  if (els.searchInput) {
    if (selectedField === 'emisor') {
      els.searchInput.placeholder = 'Buscar proveedor...';
    } else if (selectedField === 'rfcEmisor') {
      els.searchInput.placeholder = 'Buscar RFC...';
    } else if (selectedField === 'uuid') {
      els.searchInput.placeholder = 'Buscar UUID...';
    } else {
      els.searchInput.placeholder = `Buscar ${fieldName.toLowerCase()}...`;
    }
  }

  if (els.filterAnalyzedSelect) {
    els.filterAnalyzedSelect.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = `-- Todos (${list.length}) --`;
    els.filterAnalyzedSelect.appendChild(defOpt);

    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = item.name;
      opt.textContent = `${item.name} (${item.count} · ${formatMoney(item.total)})`;
      els.filterAnalyzedSelect.appendChild(opt);
    }
  }

  if (els.analyzedDatalist) {
    els.analyzedDatalist.innerHTML = '';
    for (const item of list) {
      const dataOpt = document.createElement('option');
      dataOpt.value = item.name;
      dataOpt.label = `${item.count} · ${formatMoney(item.total)}`;
      els.analyzedDatalist.appendChild(dataOpt);
    }
  }
}

export function filterInvoices(invoices, { currentFilter, selectedField, query, minPrice, maxPrice }) {
  const hasMinPrice = !isNaN(minPrice) && minPrice >= 0;
  const hasMaxPrice = !isNaN(maxPrice) && maxPrice >= 0;

  return invoices.filter((inv) => {
    const invCents = toCents(inv.total);
    if (invCents < 10000) return false;

    if (currentFilter === 'pagadas' && inv.estadoPago !== 'Pagada') return false;
    if (currentFilter === 'no_pagadas' && inv.estadoPago !== 'No Pagada') return false;
    if (currentFilter === 'egresos' && inv.efecto !== 'Egreso') return false;
    if (currentFilter === 'canceladas' && inv.estadoPago !== 'Cancelada') return false;

    const invTotal = fromCents(invCents);
    if (hasMinPrice && invTotal < minPrice) return false;
    if (hasMaxPrice && invTotal > maxPrice) return false;

    if (query) {
      return checkFieldMatch(inv, selectedField, query);
    }
    return true;
  });
}
