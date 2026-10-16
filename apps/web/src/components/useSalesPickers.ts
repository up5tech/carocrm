import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { LineProductOption } from './LineItemEditor.js';

/**
 * The two catalogs a line editor needs: the products to pick and the tax codes to apply.
 *
 * Both are bounded lookups — a document never needs the whole catalog, and an unbounded list is a
 * page the user has to scroll. A failed lookup leaves the editor showing what it already has, because
 * a picker that will not open is a worse answer than one that is missing.
 */
export function useSalesPickers(): {
  readonly products: readonly LineProductOption[];
  readonly taxCodes: readonly { value: string; label: string }[];
} {
  const [products, setProducts] = useState<readonly LineProductOption[]>([]);
  const [taxCodes, setTaxCodes] = useState<readonly { value: string; label: string }[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [catalog, codes] = await Promise.all([
          api.list('Product', { maxSize: 300, orderBy: 'name,asc', where: [{ field: 'active', operator: 'equals', value: true }] }),
          api.list('TaxCode', { maxSize: 200, orderBy: 'name,asc' }),
        ]);
        if (!active) return;
        setProducts(
          catalog.list.map((row) => ({
            value: String(row['id']),
            label: String(row['name'] ?? ''),
            sku: (row['sku'] as string | null) ?? null,
            unit: (row['unit'] as string | null) ?? null,
            listPrice: (row['listPrice'] as string | null) ?? (row['unitPrice'] as string | null) ?? null,
          })),
        );
        setTaxCodes(codes.list.map((row) => ({ value: String(row['id']), label: String(row['name'] ?? '') })));
      } catch {
        if (active) {
          setProducts([]);
          setTaxCodes([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return { products, taxCodes };
}
