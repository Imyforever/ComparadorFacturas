/**
 * Estado unico compartido del dashboard.
 */

export const state = {
  // Facturas No Pagadas seleccionadas para marcarlas en bloque como pagadas en efectivo
  selectedUuids: new Set(),
  currentPeriodo: '2026-09',
  currentEntidad: 'Personal',
  cachedTabs: [],
  currentFilter: 'all',
  selectedField: 'emisor',
  currentViewMode: 'detail',
  cachedInvoices: [],
  cachedUnmatchedMovements: [],
  cachedAutoNcAssignments: [],
  activeEditingUuid: null,
  activeRenamingTab: null,
  activeCompareMovement: null,
  compareSimilarOnly: true,
  selectedCompareInvoiceUuid: null
};
