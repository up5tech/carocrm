import type { DocInline as DocInlineModel } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { DocInlines, type DocLinkContext } from './DocInline.js';

/**
 * A handbook table: semantic markup inside its own scroll container, not an antd `Table`.
 *
 * antd's Table brings sorting, paging and selection for data a handbook page does not have, and it renders
 * the header as a toolbar. Prose tables need the plain `<table>` semantics a screen reader announces row by
 * row, plus a horizontal scroll that belongs to the table rather than to the page (§5.10).
 */
export function DocTable({
  align,
  head,
  rows,
  context,
}: {
  readonly align: readonly ('left' | 'center' | 'right' | null)[];
  readonly head: readonly (readonly DocInlineModel[])[];
  readonly rows: readonly (readonly (readonly DocInlineModel[])[])[];
  readonly context: DocLinkContext;
}) {
  return (
    <div className="carocrm-doc-table-scroll" tabIndex={0} role="region" aria-label={t('web.docs.tableRegion')}>
      <table className="carocrm-doc-table">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={`head-${String(index)}`} scope="col" style={alignOf(align[index])}>
                <DocInlines inlines={cell} context={context} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${String(rowIndex)}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${String(rowIndex)}-${String(cellIndex)}`} style={alignOf(align[cellIndex])}>
                  <DocInlines inlines={cell} context={context} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function alignOf(alignment: 'left' | 'center' | 'right' | null | undefined): React.CSSProperties {
  return alignment === null || alignment === undefined ? {} : { textAlign: alignment };
}
