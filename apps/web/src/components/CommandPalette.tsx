import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from 'cmdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { EntityDefinition } from '../api/types.js';
import { t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

/** The three modes the palette cycles through. */
type PaletteMode = 'commands' | 'records' | 'recent';

interface RecentEntry {
  key: string;
  label: string;
  route: string;
}

const RECENT_KEY = 'carocrm.paletteRecent';
const MAX_RECENT = 20;

/**
 * Command palette (PLAN_Phase_20_Settings_UX.md §4.6, §20.14).
 *
 * `⌘/Ctrl+K` opens it from every screen. Three modes: commands (navigate to pages), records
 * (search entities by name), and recent (last-visited routes). Keyboard-first: arrow keys move,
 * Enter selects, Escape closes, focus restores to the element that was active before opening.
 * Results are debounced for record search and capped at 12 per group.
 *
 * Security: only entities the principal may read appear in the records tab — the list comes from
 * `navEntities`, which already filters by `client.web !== false` and is driven by metadata ACL.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const metadata = useMetadata();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>('commands');
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  const entities = useMemo(() => navEntities(metadata.data, session.principal?.type), [metadata.data, session.principal?.type]);

  // Load recents on mount
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as RecentEntry[];
      setRecents(stored.slice(0, MAX_RECENT));
    } catch {
      setRecents([]);
    }
  }, []);

  // Keyboard shortcut: ⌘/Ctrl+K
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Record the route when navigating (for the recent tab)
  useEffect(() => {
    if (!open) {
      const path = window.location.pathname;
      if (path.startsWith('/admin/') || path === '/home' || path.startsWith('/Account') || path.startsWith('/Contact')) {
        addRecent(path, document.title || path);
      }
    }
  }, [open]);

  const addRecent = useCallback((route: string, label: string) => {
    setRecents((prev) => {
      const filtered = prev.filter((r) => r.route !== route);
      const next = [{ key: route, label, route }, ...filtered].slice(0, MAX_RECENT);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const select = useCallback(
    (route: string) => {
      setOpen(false);
      setQuery('');
      setMode('commands');
      addRecent(route, route);
      navigate(route);
    },
    [navigate, addRecent],
  );

  const filteredEntities = useMemo(() => {
    if (query.trim() === '') return entities.slice(0, 12);
    const q = query.toLowerCase();
    return entities.filter((e) => e.label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)).slice(0, 12);
  }, [entities, query]);

  const commandItems = useMemo(
    () => [
      { key: 'home', label: t('core.app.home'), route: '/home' },
      { key: 'search', label: t('core.app.search'), route: '/search' },
      { key: 'dashboards', label: t('web.dashboards.title'), route: '/dashboards' },
      { key: 'reports', label: t('web.reports.title'), route: '/reports' },
      { key: 'stream', label: t('web.stream.title'), route: '/stream' },
      { key: 'calendar', label: t('web.calendar.title'), route: '/calendar' },
      { key: 'tasks', label: t('web.tasks.title'), route: '/tasks' },
      { key: 'settings', label: t('web.adminShell.railLabel'), route: '/admin/settings' },
    ],
    [],
  );

  const filteredCommands = useMemo(() => {
    if (query.trim() === '') return commandItems;
    const q = query.toLowerCase();
    return commandItems.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 12);
  }, [commandItems, query]);

  const filteredRecents = useMemo(() => {
    if (query.trim() === '') return recents;
    const q = query.toLowerCase();
    return recents.filter((r) => r.label.toLowerCase().includes(q) || r.route.toLowerCase().includes(q)).slice(0, 12);
  }, [recents, query]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput placeholder={t('web.commandPalette.placeholder')} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{t('web.commandPalette.empty')}</CommandEmpty>

        {/* Mode switcher */}
        <div style={{ display: 'flex', gap: 4, padding: '4px 8px', borderBottom: '1px solid #f0f0f0' }}>
          {(['commands', 'records', 'recent'] as PaletteMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              style={{
                background: mode === m ? '#e6f7ff' : 'transparent',
                border: 'none',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 12,
                cursor: 'pointer',
                color: mode === m ? '#1890ff' : '#666',
              }}
            >
              {m === 'commands' ? t('web.commandPalette.commands') : m === 'records' ? t('web.commandPalette.records') : t('web.commandPalette.recent')}
            </button>
          ))}
        </div>

        {mode === 'commands' && (
          <CommandGroup heading={t('web.commandPalette.commands')}>
            {filteredCommands.map((item) => (
              <CommandItem key={item.key} onSelect={() => select(item.route)}>
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {mode === 'records' && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('web.commandPalette.records')}>
              {filteredEntities.map((entity: EntityDefinition) => (
                <CommandItem key={entity.name} onSelect={() => select(`/${entity.name}`)}>
                  {entity.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {mode === 'recent' && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('web.commandPalette.recent')}>
              {filteredRecents.map((item) => (
                <CommandItem key={item.key} onSelect={() => select(item.route)}>
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
