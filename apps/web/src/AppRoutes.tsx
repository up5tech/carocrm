import { Spin } from 'antd';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminSettingsShell } from './admin/AdminSettingsShell.js';
import { AppShell } from './components/AppShell.js';
import { LoadingSkeleton } from './components/LoadingSkeleton.js';
const AdminAuditPage = lazy(() => import('./pages/AdminAuditPage.js').then((m) => ({ default: m.AdminAuditPage })));
const AdminExtensionsPage = lazy(() => import('./pages/AdminExtensionsPage.js').then((m) => ({ default: m.AdminExtensionsPage })));
const AdminJobsPage = lazy(() => import('./pages/AdminJobsPage.js').then((m) => ({ default: m.AdminJobsPage })));
const AdminPortalsPage = lazy(() => import('./pages/AdminPortalsPage.js').then((m) => ({ default: m.AdminPortalsPage })));
const AdvancedIntegrationsPage = lazy(() => import('./pages/AdvancedIntegrationsPage.js').then((m) => ({ default: m.AdvancedIntegrationsPage })));
const AIAgentsPage = lazy(() => import('./pages/AIAgentsPage.js').then((m) => ({ default: m.AIAgentsPage })));
const CalendarPage = lazy(() => import('./pages/CalendarPage.js').then((m) => ({ default: m.CalendarPage })));
const CRMChatPage = lazy(() => import('./pages/CRMChatPage.js').then((m) => ({ default: m.CRMChatPage })));
const DashboardsPage = lazy(() => import('./pages/DashboardsPage.js').then((m) => ({ default: m.DashboardsPage })));
const DocsLandingPage = lazy(() => import('./pages/docs/DocsLandingPage.js').then((m) => ({ default: m.DocsLandingPage })));
const DocsPage = lazy(() => import('./pages/docs/DocsPage.js').then((m) => ({ default: m.DocsPage })));
const DocsSearchPage = lazy(() => import('./pages/docs/DocsSearchPage.js').then((m) => ({ default: m.DocsSearchPage })));
const DocsSectionPage = lazy(() => import('./pages/docs/DocsSectionPage.js').then((m) => ({ default: m.DocsSectionPage })));
const DocumentTemplateDesignerPage = lazy(() => import('./pages/DocumentTemplateDesignerPage.js').then((m) => ({ default: m.DocumentTemplateDesignerPage })));
const DocumentTemplateDetailPage = lazy(() => import('./pages/DocumentTemplateDetailPage.js').then((m) => ({ default: m.DocumentTemplateDetailPage })));
const EmailTemplateDesignerPage = lazy(() => import('./pages/EmailTemplateDesignerPage.js').then((m) => ({ default: m.EmailTemplateDesignerPage })));
const EntityAdminPage = lazy(() => import('./pages/EntityAdminPage.js').then((m) => ({ default: m.EntityAdminPage })));
const EntityBoardPage = lazy(() => import('./pages/EntityBoardPage.js').then((m) => ({ default: m.EntityBoardPage })));
const EntityDetailPage = lazy(() => import('./pages/EntityDetailPage.js').then((m) => ({ default: m.EntityDetailPage })));
const EntityEditPage = lazy(() => import('./pages/EntityEditPage.js').then((m) => ({ default: m.EntityEditPage })));
const EntityListPage = lazy(() => import('./pages/EntityListPage.js').then((m) => ({ default: m.EntityListPage })));
const EntityManagerPage = lazy(() => import('./pages/EntityManagerPage.js').then((m) => ({ default: m.EntityManagerPage })));
const ESignaturePage = lazy(() => import('./pages/ESignaturePage.js').then((m) => ({ default: m.ESignaturePage })));
const HomePage = lazy(() => import('./pages/HomePage.js').then((m) => ({ default: m.HomePage })));
const LeadScorePage = lazy(() => import('./pages/LeadScorePage.js').then((m) => ({ default: m.LeadScorePage })));
const LoginPage = lazy(() => import('./pages/LoginPage.js').then((m) => ({ default: m.LoginPage })));
const MarketingPreferencesPage = lazy(() => import('./pages/MarketingPreferencesPage.js').then((m) => ({ default: m.MarketingPreferencesPage })));
const MyProfilePage = lazy(() => import('./pages/MyProfilePage.js').then((m) => ({ default: m.MyProfilePage })));
const PortalCsatPage = lazy(() => import('./pages/PortalCsatPage.js').then((m) => ({ default: m.PortalCsatPage })));
const PortalHomePage = lazy(() => import('./pages/PortalHomePage.js').then((m) => ({ default: m.PortalHomePage })));
const ProcessEditorPage = lazy(() => import('./pages/ProcessEditorPage.js').then((m) => ({ default: m.ProcessEditorPage })));
const ProcessesPage = lazy(() => import('./pages/ProcessesPage.js').then((m) => ({ default: m.ProcessesPage })));
const ProjectBoardPage = lazy(() => import('./pages/projects/ProjectBoardPage.js').then((m) => ({ default: m.ProjectBoardPage })));
const ProjectGanttPage = lazy(() => import('./pages/projects/ProjectGanttPage.js').then((m) => ({ default: m.ProjectGanttPage })));
const ProjectMembersPage = lazy(() => import('./pages/projects/ProjectMembersPage.js').then((m) => ({ default: m.ProjectMembersPage })));
const ProjectPlanPage = lazy(() => import('./pages/projects/ProjectPlanPage.js').then((m) => ({ default: m.ProjectPlanPage })));
const ProjectSettingsPage = lazy(() => import('./pages/projects/ProjectSettingsPage.js').then((m) => ({ default: m.ProjectSettingsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage.js').then((m) => ({ default: m.ReportsPage })));
const SearchPage = lazy(() => import('./pages/SearchPage.js').then((m) => ({ default: m.SearchPage })));
const ServiceDeskDashboardPage = lazy(() => import('./pages/ServiceDeskDashboardPage.js').then((m) => ({ default: m.ServiceDeskDashboardPage })));
const StreamPage = lazy(() => import('./pages/StreamPage.js').then((m) => ({ default: m.StreamPage })));
const TasksPage = lazy(() => import('./pages/TasksPage.js').then((m) => ({ default: m.TasksPage })));
const VoiceCommunicationsPage = lazy(() => import('./pages/VoiceCommunicationsPage.js').then((m) => ({ default: m.VoiceCommunicationsPage })));
const VoiceInboxPage = lazy(() => import('./pages/VoiceInboxPage.js').then((m) => ({ default: m.VoiceInboxPage })));
const WorkflowEditorPage = lazy(() => import('./pages/WorkflowEditorPage.js').then((m) => ({ default: m.WorkflowEditorPage })));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage.js').then((m) => ({ default: m.WorkflowsPage })));
import { useSession } from './state/session.js';

export function AppRoutes() {
  const { token, principal, restored, loadPrincipal } = useSession();

  useEffect(() => {
    void loadPrincipal();
  }, [loadPrincipal]);

  if (!restored || (token && !principal)) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!token || !principal) {
    return (
      <Suspense fallback={<LoadingSkeleton rows={8} />}>
        <Routes>
        {/* SD.14 — the CSAT link is token-based and must work without a CRM session. */}
        <Route path="/csat" element={<PortalCsatPage />} />
        {/* Phase 19-MA.5 — the public preference page: no session, token only (§5.3.1). */}
        <Route path="/marketing/preferences" element={<MarketingPreferencesPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      </Suspense>
    );
  }

  // Phase 18: a portal user only ever sees the portal routes (PLAN §37). Internal routes —
  // including the admin screens — redirect back to the portal home.
  if (principal.type === 'portal') {
    return (
      <AppShell>
        <Suspense fallback={<LoadingSkeleton rows={8} />}>
        <Routes>
          <Route path="/" element={<Navigate to="/portal" replace />} />
          <Route path="/portal" element={<PortalHomePage />} />
          <Route path="/portal/csat" element={<PortalCsatPage />} />
          {/* The generated list/detail pages read the `:entity`/`:id` params, so the portal
              reuses them; every read they perform is portal-ACL scoped server-side. */}
          <Route path="/portal/:entity" element={<EntityListPage />} />
          {/* the same generated board; every read it makes is portal-ACL scoped server-side */}
          <Route path="/portal/:entity/board" element={<EntityBoardPage />} />
          <Route path="/portal/:entity/create" element={<EntityEditPage />} />
          <Route path="/portal/:entity/:id" element={<EntityDetailPage />} />
          <Route path="/portal/:entity/:id/edit" element={<EntityEditPage />} />
          <Route path="/login" element={<Navigate to="/portal" replace />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </Suspense>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<LoadingSkeleton rows={8} />}>
        <Routes>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        {/* SD.14 — the same token survey page is reachable for signed-in staff testing a link. */}
        <Route path="/csat" element={<PortalCsatPage />} />
        {/* Phase 19-MA.5 — the public preference page: no session, token only (§5.3.1). */}
        <Route path="/marketing/preferences" element={<MarketingPreferencesPage />} />
        {/* signed-in users must never hit the entity route with "login" as the entity name */}
        <Route path="/login" element={<Navigate to="/home" replace />} />
        {/* declared before the entity wildcard so "stream" is never read as an entity name */}
        <Route path="/stream" element={<StreamPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/dashboards" element={<DashboardsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        {/* The approvals surface moved into /tasks (one page, one sidebar entry). The old route
            still resolves — bookmarks and links in older documents keep working — and it opens the
            approvals surface directly. Declared before the entity wildcard so "processes" is never
            read as an entity name. */}
        <Route path="/processes" element={<Navigate to="/tasks?tab=approvals" replace />} />
        {/* Phase 19-AI: a static module page, declared before the entity wildcard so "ai-agents"
            is never read as an entity name. Visibility is decided by the server's navigation. */}
        <Route path="/ai-agents" element={<AIAgentsPage />} />
        {/* Phase 19-CHAT: the conversational workspace. Also a static route, so "crm-chat" is never
            read as an entity name; visibility and authorization are decided by the server. */}
        <Route path="/crm-chat" element={<CRMChatPage />} />
        {/* Phase 19-VC: the module's diagnostics page, before the entity wildcard. */}
        <Route path="/voice-inbox" element={<VoiceInboxPage />} />
        <Route path="/voice-communications" element={<VoiceCommunicationsPage />} />
        {/* Phase 19-INT.14: the connector workspace, before the entity wildcard so
            "advanced-integrations" is never read as an entity name. */}
        <Route path="/advanced-integrations" element={<AdvancedIntegrationsPage />} />
        {/* Phase 19-ES.1: the e-signature module page, before the entity wildcard so "esignature"
            is never read as an entity name. Visibility and authorization are decided by the server. */}
        <Route path="/esignature" element={<ESignaturePage />} />
        {/* Phase 19-LS.8: the scoring model workspace, before the entity wildcard so "lead-score"
            is never read as an entity name. Visibility and authorization are decided by the server. */}
        <Route path="/lead-score" element={<LeadScorePage />} />
        {/* Phase 21.5: the handbook. `/docs/search` is declared before `/docs/:section` so the word
            "search" is never read as a section name, and all four sit before the entity wildcard so
            "docs" is never read as an entity. */}
        <Route path="/docs" element={<DocsLandingPage />} />
        <Route path="/docs/search" element={<DocsSearchPage />} />
        <Route path="/docs/:section" element={<DocsSectionPage />} />
        <Route path="/docs/:section/:slug" element={<DocsPage />} />
        {/* the signed-in user's own page, before the entity wildcard reads "profile" as an entity */}
        <Route path="/profile" element={<MyProfilePage />} />
        {/* Phase 19: the Projects views are static routes, matched before the entity wildcard */}
        <Route path="/Project/:id/plan" element={<ProjectPlanPage />} />
        <Route path="/Project/:id/board" element={<ProjectBoardPage />} />
        <Route path="/Project/:id/gantt" element={<ProjectGanttPage />} />
        <Route path="/Project/:id/members" element={<ProjectMembersPage />} />
        <Route path="/Project/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/Case/dashboard" element={<ServiceDeskDashboardPage />} />
        {/* The email template workspace owns the create and edit routes of one entity, so it is declared
            before the entity wildcard that would otherwise serve its generic form. */}
        <Route path="/EmailTemplate/create" element={<EmailTemplateDesignerPage />} />
        <Route path="/EmailTemplate/:id/edit" element={<EmailTemplateDesignerPage />} />
        {/* The document template workspace owns its own create/edit/detail views: a template's body is
            source, so the generic record form is the wrong surface for it. */}
        <Route path="/DocumentTemplate/create" element={<DocumentTemplateDesignerPage />} />
        <Route path="/DocumentTemplate/:id/edit" element={<DocumentTemplateDesignerPage />} />
        <Route path="/DocumentTemplate/:id" element={<DocumentTemplateDetailPage />} />
        {/* declared before the entity wildcard so "board" is never read as a record id */}
        <Route path="/:entity/board" element={<EntityBoardPage />} />
        <Route path="/:entity" element={<EntityListPage />} />
        <Route path="/:entity/create" element={<EntityEditPage />} />
        <Route path="/:entity/:id" element={<EntityDetailPage />} />
        <Route path="/:entity/:id/edit" element={<EntityEditPage />} />
        <Route path="/admin/entity-manager" element={<EntityManagerPage />} />
        <Route path="/admin/entity-manager/:entityName" element={<EntityAdminPage />} />
        <Route path="/admin/audit-log" element={<AdminAuditPage />} />
        <Route path="/admin/jobs" element={<AdminJobsPage />} />
        <Route path="/admin/extensions" element={<AdminExtensionsPage />} />
        <Route path="/admin/workflows" element={<WorkflowsPage />} />
        <Route path="/admin/workflows/:id" element={<WorkflowEditorPage />} />
        <Route path="/admin/processes" element={<ProcessesPage />} />
        <Route path="/admin/processes/:id" element={<ProcessEditorPage />} />
        <Route path="/admin/portals" element={<AdminPortalsPage />} />
        {/* Phase 20: the settings shell owns `/admin/settings/:tabKey`; the bare URL redirects to the
            first tab this caller may open, so existing bookmarks keep landing somewhere useful. */}
        <Route path="/admin/settings" element={<AdminSettingsShell />} />
        <Route path="/admin/settings/:tabKey" element={<AdminSettingsShell />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
      </Suspense>
    </AppShell>
  );
}