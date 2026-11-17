/**
 * Utilidades puras de formato (moneda, centavos enteros, fechas y escape HTML).
 */

export function toCents(val) {
  return Math.round(Number(val || 0) * 100);
}

export function fromCents(cents) {
  return cents / 100;
}

export function sumCents(items, getter) {
  let totalCents = 0;
  for (const item of items) {
    totalCents += toCents(getter(item));
  }
  return fromCents(totalCents);
}

export function formatMoney(val) {
  return '$' + Number(val || 0).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function formatShortDate(dateVal) {
  if (!dateVal) return '-';
  return String(dateVal).split('T')[0] || '-';
}

export function formatDateTime(dateVal) {
  if (!dateVal) return '-';
  return new Date(dateVal).toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getBankBadgeClass(banco) {
  if (/bbva/i.test(banco || '')) return 'bank-badge-bbva';
  if (/scotia/i.test(banco || '')) return 'bank-badge-scotia';
  return 'bank-badge-generic';
}
