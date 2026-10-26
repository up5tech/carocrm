const cache = new Set<string>();

const imports: Record<string, () => Promise<unknown>> = {
  home: () => import('../pages/HomePage.js'),
  stream: () => import('../pages/StreamPage.js'),
  calendar: () => import('../pages/CalendarPage.js'),
  search: () => import('../pages/SearchPage.js'),
  dashboards: () => import('../pages/DashboardsPage.js'),
  reports: () => import('../pages/ReportsPage.js'),
  tasks: () => import('../pages/TasksPage.js'),
  'ai-agents': () => import('../pages/AIAgentsPage.js'),
  'crm-chat': () => import('../pages/CRMChatPage.js'),
  'voice-inbox': () => import('../pages/VoiceInboxPage.js'),
  'voice-communications': () => import('../pages/VoiceCommunicationsPage.js'),
  'advanced-integrations': () => import('../pages/AdvancedIntegrationsPage.js'),
  esignature: () => import('../pages/ESignaturePage.js'),
  'lead-score': () => import('../pages/LeadScorePage.js'),
  profile: () => import('../pages/MyProfilePage.js'),
};

function run(key: string): void {
  if (cache.has(key)) return;
  cache.add(key);
  const fn = imports[key];
  if (fn !== undefined) void fn().catch(() => cache.delete(key));
}

export function prefetchRoute(route: string): void {
  const path = (route.split('?')[0] ?? route).split('#')[0] ?? route;
  if (path === '/home') return run('home');
  if (path === '/stream') return run('stream');
  if (path === '/calendar') return run('calendar');
  if (path === '/search') return run('search');
  if (path === '/dashboards') return run('dashboards');
  if (path === '/reports') return run('reports');
  if (path === '/tasks') return run('tasks');
  if (path === '/ai-agents') return run('ai-agents');
  if (path === '/crm-chat') return run('crm-chat');
  if (path === '/voice-inbox') return run('voice-inbox');
  if (path === '/voice-communications') return run('voice-communications');
  if (path === '/advanced-integrations') return run('advanced-integrations');
  if (path === '/esignature') return run('esignature');
  if (path === '/lead-score') return run('lead-score');
  if (path === '/profile') return run('profile');
  if (path === '/portal' || path.startsWith('/portal/')) {
    // portal reuses entity pages
    if (path.endsWith('/board')) return run('board' as never);
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return;
  const first = segments[0] ?? '';
  // entity wildcard
  if (segments.length === 1) {
    if (!imports[first]) void import('../pages/EntityListPage.js').catch(() => {});
    else return;
    return;
  }
  if (segments[1] === 'board') void import('../pages/EntityBoardPage.js').catch(() => {});
  else if (segments[1] === 'create' || segments[2] === 'edit') void import('../pages/EntityEditPage.js').catch(() => {});
  else if (segments.length === 2) void import('../pages/EntityDetailPage.js').catch(() => {});
  else void import('../pages/EntityListPage.js').catch(() => {});
  if (path.startsWith('/Project/')) {
    const sub = segments[2];
    if (sub === 'plan') void import('../pages/projects/ProjectPlanPage.js').catch(() => {});
    if (sub === 'board') void import('../pages/projects/ProjectBoardPage.js').catch(() => {});
    if (sub === 'gantt') void import('../pages/projects/ProjectGanttPage.js').catch(() => {});
    if (sub === 'members') void import('../pages/projects/ProjectMembersPage.js').catch(() => {});
    if (sub === 'settings') void import('../pages/projects/ProjectSettingsPage.js').catch(() => {});
  }
  if (path.startsWith('/docs')) void import('../pages/docs/DocsPage.js').catch(() => {});
  if (path.startsWith('/admin/settings')) void import('../admin/AdminSettingsShell.js').catch(() => {});
}
