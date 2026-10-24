import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from 'cmdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { EntityDefinition, NavigationNode } from '../api/types.js';
import { useNavigation } from '../state/admin.js';
import { useDocPaletteItems } from '../state/docs.js';
import { currentNavRoute, useFavorites } from '../state/favorites.js';
import { t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { useRecentRoutes } from '../state/recent.js';
import { useSession } from '../state/session.js';

/** The three modes the palette cycles through. */
type PaletteMode = 'commands' | 'records' | 'recent';

interface CommandEntry {
  key: string;
  label: string;
  route?: string;
  run?: () => void;
}

/** The plan's cap for one group (§5.2): enough to be useful, short enough to stay keyboard-sized. */
const RESULT_CAP = 20;

/** Route → label for everything the resolved menu carries, so a recent entry reads as a page. */
function labelsByRoute(nodes: readonly NavigationNode[], out = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    if (node.kind !== 'group') out.set(node.route, node.label);
    if (node.children !== undefined) labelsByRoute(node.children, out);
  }
  return out;
}

/** Whether the resolved menu really offers this route — the palette never pins what cannot render. */
function carriesRoute(nodes: readonly NavigationNode[], route: string): boolean {
  for (const node of nodes) {
    if (node.kind !== 'group' && node.route === route) return true;
    if (node.children !== undefined && carriesRoute(node.children, route)) return true;
  }
  return false;
}

/**
 * Command palette (PLAN_Phase_20_Settings_UX.md §5.2, §20.14).
 *
 * `⌘/Ctrl+K` and `/` open it from every screen (the `/` shortcut stays out of the way while the
 * caret is in a field, so typing a slash never steals focus). Three modes: commands (navigate, pin
 * the current page), records (the entities this caller may open) and recent (the account's own
 * last-visited routes, stored server-side in the `lastVisited` preference).
 *
 * Keyboard-first: arrow keys move, Enter selects, Escape closes, and focus returns to the element
 * that was active before opening because `cmdk` restores it. Results are capped at 20 per group,
 * with a "see all" deep link into the full search screen.
 *
 * Security: nothing here is a new permission surface. Entities come from `navEntities`, recents are
 * the caller's own preference, and pinning only offers a route the server already put on the menu.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const location = useLocation();
  const metadata = useMetadata();
  const session = useSession();
  const navigation = useNavigation();
  const favorites = useFavorites();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>('commands');
  const [query, setQuery] = useState('');

  const entities = useMemo(() => navEntities(metadata.data, session.principal?.type), [metadata.data, session.principal?.type]);
  const currentRoute = currentNavRoute(location.pathname);
  const recentRoutes = useRecentRoutes(currentRoute);
  const labels = useMemo(() => labelsByRoute(navigation.data?.items ?? []), [navigation.data]);
  const canPin = useMemo(() => carriesRoute(navigation.data?.items ?? [], currentRoute), [navigation.data, currentRoute]);

  // ⌘/Ctrl+K from anywhere; `/` when the caret is not in a field and no dialog is already open.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (typing || document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const select = useCallback(
    (route: string) => {
      setOpen(false);
      setQuery('');
      setMode('commands');
      // The visit itself is recorded by the shell (`useRecordVisit`), so a page reached by any
      // route - a link, the browser back button, this palette - lands in the same list.
      navigate(route);
    },
    [navigate],
  );

  const commandItems = useMemo<CommandEntry[]>(() => {
    const items: CommandEntry[] = [
      { key: 'home', label: t('core.app.home'), route: '/home' },
      { key: 'search', label: t('core.app.search'), route: '/search' },
      { key: 'dashboards', label: t('web.dashboards.title'), route: '/dashboards' },
      { key: 'reports', label: t('web.reports.title'), route: '/reports' },
      { key: 'stream', label: t('web.stream.title'), route: '/stream' },
      { key: 'calendar', label: t('web.calendar.title'), route: '/calendar' },
      { key: 'tasks', label: t('web.tasks.title'), route: '/tasks' },
      { key: 'crmChat', label: t('web.crmChat.title'), route: '/crm-chat' },
      { key: 'settings', label: t('web.adminShell.railLabel'), route: '/admin/settings' },
    ];
    if (canPin) {
      const pinned = favorites.isFavorite(currentRoute);
      items.unshift({
        key: 'favorite',
        label: pinned ? t('web.commandPalette.unpin') : t('web.commandPalette.pin'),
        run: () => {
          favorites.toggle(currentRoute);
          setOpen(false);
          setQuery('');
        },
      });
    }
    return items;
  }, [canPin, currentRoute, favorites.isFavorite]);

  // Nothing is requested until the palette is open, and the server decides what the caller may see.
  const docsItems = useDocPaletteItems(open, mode === 'commands' ? query : '');

  const filteredCommands = useMemo(() => {
    if (query.trim() === '') return commandItems;
    const q = query.toLowerCase();
    return commandItems.filter((c) => c.label.toLowerCase().includes(q)).slice(0, RESULT_CAP);
  }, [commandItems, query]);

  const filteredEntities = useMemo(() => {
    if (query.trim() === '') return entities.slice(0, RESULT_CAP);
    const q = query.toLowerCase();
    return entities.filter((e) => e.label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)).slice(0, RESULT_CAP);
  }, [entities, query]);

  const filteredRecents = useMemo(() => {
    const entries = recentRoutes.map((route) => ({ key: route, route, label: labels.get(route) ?? route }));
    if (query.trim() === '') return entries;
    const q = query.toLowerCase();
    return entries.filter((r) => r.label.toLowerCase().includes(q) || r.route.toLowerCase().includes(q)).slice(0, RESULT_CAP);
  }, [recentRoutes, labels, query]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false} aria-label={t('web.commandPalette.ariaLabel')}>
      <CommandInput placeholder={t('web.commandPalette.placeholder')} value={query} onValueChange={setQuery} aria-label={t('web.commandPalette.inputAria')} />
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
          <>
            <CommandGroup heading={t('web.commandPalette.commands')}>
              {filteredCommands.map((item) => (
                <CommandItem
                  key={item.key}
                  onSelect={() => {
                    if (item.run) item.run();
                    else if (item.route !== undefined) select(item.route);
                  }}
                >
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t('web.docs.title')}>
              {docsItems.items.map((item) => (
                <CommandItem key={item.key} onSelect={() => select(item.path)}>
                  {item.title}
                  <span className="carocrm-palette-detail">{item.detail}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
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
              {query.trim() === '' ? null : (
                <CommandItem key="see-all" onSelect={() => select(`/search?q=${encodeURIComponent(query.trim())}`)}>
                  {t('web.commandPalette.seeAll')}
                </CommandItem>
              )}
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
                  <span className="carocrm-palette-detail">{item.route}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
