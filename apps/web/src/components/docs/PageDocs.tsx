import { createContext, type Dispatch, type ReactNode, type SetStateAction, useContext, useEffect, useMemo, useState } from 'react';

const docsKeyContext = createContext<{
  readonly key: string | undefined;
  readonly setKey: Dispatch<SetStateAction<string | undefined>>;
}>({ key: undefined, setKey: () => undefined });

/**
 * The shell header shows the handbook link for the screen being read, so screens no longer repeat a
 * book icon in their own titles. A screen publishes its page key once and the header owns the link.
 */
export function PageDocsProvider({ children }: { readonly children: ReactNode }) {
  const [key, setKey] = useState<string | undefined>(undefined);
  const value = useMemo(() => ({ key, setKey }), [key]);
  return <docsKeyContext.Provider value={value}>{children}</docsKeyContext.Provider>;
}

export function usePageDocsKey(): string | undefined {
  return useContext(docsKeyContext).key;
}

/** Publishes the key while the calling screen is mounted; leaving the screen clears it. */
export function usePageDocs(docKey: string | undefined): void {
  const setKey = useContext(docsKeyContext).setKey;
  useEffect(() => {
    setKey(docKey);
    return () => setKey((current) => (current === docKey ? undefined : current));
  }, [docKey, setKey]);
}
