import { Spin } from 'antd';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell.js';
import { AdminAuditPage } from './pages/AdminAuditPage.js';
import { AdminJobsPage } from './pages/AdminJobsPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { EntityDetailPage } from './pages/EntityDetailPage.js';
import { EntityEditPage } from './pages/EntityEditPage.js';
import { EntityListPage } from './pages/EntityListPage.js';
import { EntityManagerPage } from './pages/EntityManagerPage.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { StreamPage } from './pages/StreamPage.js';
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
        <Route path="/:entity" element={<EntityListPage />} />
        <Route path="/:entity/create" element={<EntityEditPage />} />
        <Route path="/:entity/:id" element={<EntityDetailPage />} />
        <Route path="/:entity/:id/edit" element={<EntityEditPage />} />
        <Route path="/admin/entity-manager" element={<EntityManagerPage />} />
        <Route path="/admin/audit-log" element={<AdminAuditPage />} />
        <Route path="/admin/jobs" element={<AdminJobsPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AppShell>
  );
}
