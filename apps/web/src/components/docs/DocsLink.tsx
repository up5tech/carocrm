import { BookOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import { Link } from 'react-router-dom';

import { useDocsHref } from '../../state/docs.js';
import { t } from '../../state/i18n.js';

/**
 * The one way a screen links to its handbook page (§5.6): the shell header's current-screen book and a
 * HelpTip's "Learn more" both render this, so they follow `externalUrl` and disappear together when the
 * instance switches the handbook off.
 *
 * `compact` is the icon-only form the header uses, where a text link would crowd the account menu; it
 * still carries an accessible name, because an icon with no label is a button nobody can find out
 * anything about.
 */
export function DocsLink({
  docKey,
  compact = false,
  label,
  className,
}: {
  readonly docKey: string | undefined;
  readonly compact?: boolean;
  readonly label?: string;
  readonly className?: string;
}) {
  const href = useDocsHref(docKey);
  const text = label ?? t('web.docs.link');

  if (href === null) return null;

  const external = !href.startsWith('/');
  const content = compact ? (
    <Tooltip title={text}>
      {external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={text} className={`carocrm-docs-link carocrm-docs-link--compact ${className ?? ''}`}>
          <BookOutlined aria-hidden />
        </a>
      ) : (
        <Link to={href} aria-label={text} className={`carocrm-docs-link carocrm-docs-link--compact ${className ?? ''}`}>
          <BookOutlined aria-hidden />
        </Link>
      )}
    </Tooltip>
  ) : external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`carocrm-docs-link ${className ?? ''}`}>
      <BookOutlined aria-hidden /> {text}
    </a>
  ) : (
    <Link to={href} className={`carocrm-docs-link ${className ?? ''}`}>
      <BookOutlined aria-hidden /> {text}
    </Link>
  );

  return content;
}
