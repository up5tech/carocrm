/** Minimal RFC-4180 CSV helpers (PLAN §32: CSV first, no external dependency). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const normalized = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (quoted) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && normalized[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers = [], ...rest] = rows;
  return { headers, rows: rest };
}

export function toCsvText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => String(item)).join(';');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function csvCell(text: string): string {
  // Formula injection guard (AGENTS §5.3): Excel executes a cell starting with = + - @ once the
  // exported CSV is opened, so record data must never begin a formula.
  const safe = /^[=+\-@]/.test(text) || text.startsWith('\t') || text.startsWith('\r') ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function safeJson(text: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}
