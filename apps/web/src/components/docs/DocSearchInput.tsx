import { SearchOutlined } from '@ant-design/icons';
import { Input } from 'antd';
import { useEffect, useState } from 'react';

/**
 * The handbook search field (§5.4).
 *
 * Two behaviours that look small and are the whole point: the query is written to the address bar, so a
 * search is copyable and the back button returns to the results you had; and the field debounces, so a
 * reader typing a Vietnamese phrase without diacritics does not fire six requests on the way to `cau hinh`.
 *
 * The parent owns the value, which keeps the URL the single source of truth.
 */
export function DocSearchInput({
  value,
  placeholder,
  ariaLabel,
  submitLabel,
  onChange,
  onSubmit,
  autoFocus,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly submitLabel: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (next: string) => void;
  readonly autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    // An external change (back button, a link with ?q=) wins over the local draft; typing does not.
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onChange(draft), 200);
    return () => window.clearTimeout(timer);
  }, [draft, value, onChange]);

  return (
    <Input
      className="carocrm-doc-search"
      size="large"
      allowClear
      autoFocus={autoFocus}
      prefix={<SearchOutlined aria-hidden />}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPressEnter={() => onSubmit(draft)}
      suffix={<span className="carocrm-doc-search-hint">{submitLabel}</span>}
    />
  );
}
