/**
 * Estado unico compartido del dashboard.
 */

export const state = {
  currentPeriodo: '2026-09',
  currentEntidad: 'Personal',
  cachedTabs: [],
  currentFilter: 'all',
  selectedField: 'emisor',
  currentViewMode: 'detail',
  cachedInvoices: [],
  cachedUnmatchedMovements: [],
  activeEditingUuid: null,
  activeRenamingTab: null,
  activeCompareMovement: null,
  compareSimilarOnly: true,
  selectedCompareInvoiceUuid: null
};
