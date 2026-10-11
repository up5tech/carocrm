export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function camelCase(s: string): string {
  return s.replace(/([-_][a-z])/g, (g) => (g[1] ?? '').toUpperCase());
}

export function kebabCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function snakeCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

export function truncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return s.substring(0, maxLength - 3) + '...';
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}