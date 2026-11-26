/** Chuyển giá trị AI trả về thành số; giá trị rỗng/không hợp lệ trả về null thay vì 0. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** Đổi chuỗi DD/MM/YYYY thành Date UTC (00:00); sai định dạng trả về null. */
export function parseVnDate(value: string | null | undefined): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || '');
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return date.getUTCDate() === Number(match[1]) ? date : null;
}
