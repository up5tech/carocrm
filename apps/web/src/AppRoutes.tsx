import { Spin } from 'antd';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell.js';
import { AdminAuditPage } from './pages/AdminAuditPage.js';
import { AdminExtensionsPage } from './pages/AdminExtensionsPage.js';
import { AdminJobsPage } from './pages/AdminJobsPage.js';
import { AdminPortalsPage } from './pages/AdminPortalsPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { DashboardsPage } from './pages/DashboardsPage.js';
import { EntityAdminPage } from './pages/EntityAdminPage.js';
import { EntityDetailPage } from './pages/EntityDetailPage.js';
import { EntityEditPage } from './pages/EntityEditPage.js';
import { EntityListPage } from './pages/EntityListPage.js';
import { EntityManagerPage } from './pages/EntityManagerPage.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { PortalHomePage } from './pages/PortalHomePage.js';
import { ProcessEditorPage } from './pages/ProcessEditorPage.js';
import { ProcessesPage } from './pages/ProcessesPage.js';
import { ProjectBoardPage } from './pages/projects/ProjectBoardPage.js';
import { ProjectGanttPage } from './pages/projects/ProjectGanttPage.js';
import { ProjectMembersPage } from './pages/projects/ProjectMembersPage.js';
import { ProjectPlanPage } from './pages/projects/ProjectPlanPage.js';
import { ProjectSettingsPage } from './pages/projects/ProjectSettingsPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { StreamPage } from './pages/StreamPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { WorkflowEditorPage } from './pages/WorkflowEditorPage.js';
import { WorkflowsPage } from './pages/WorkflowsPage.js';
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
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Phase 18: a portal user only ever sees the portal routes (PLAN §37). Internal routes —
  // including the admin screens — redirect back to the portal home.
  if (principal.type === 'portal') {
    return (
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/portal" replace />} />
          <Route path="/portal" element={<PortalHomePage />} />
          {/* The generated list/detail pages read the `:entity`/`:id` params, so the portal
              reuses them; every read they perform is portal-ACL scoped server-side. */}
          <Route path="/portal/:entity" element={<EntityListPage />} />
          <Route path="/portal/:entity/create" element={<EntityEditPage />} />
          <Route path="/portal/:entity/:id" element={<EntityDetailPage />} />
          <Route path="/portal/:entity/:id/edit" element={<EntityEditPage />} />
          <Route path="/login" element={<Navigate to="/portal" replace />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        {/* signed-in users must never hit the entity route with "login" as the entity name */}
        <Route path="/login" element={<Navigate to="/home" replace />} />
        {/* declared before the entity wildcard so "stream" is never read as an entity name */}
        <Route path="/stream" element={<StreamPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/dashboards" element={<DashboardsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        {/* Phase 19: the Projects views are static routes, matched before the entity wildcard */}
        <Route path="/Project/:id/plan" element={<ProjectPlanPage />} />
        <Route path="/Project/:id/board" element={<ProjectBoardPage />} />
        <Route path="/Project/:id/gantt" element={<ProjectGanttPage />} />
        <Route path="/Project/:id/members" element={<ProjectMembersPage />} />
        <Route path="/Project/:id/settings" element={<ProjectSettingsPage />} />
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
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AppShell>
  );
}
