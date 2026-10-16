import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { useData } from "./lib/use-data";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { AgentSetupPage } from "./pages/AgentSetup";
import { AccountDetailPage } from "./pages/AccountDetail";
import { AccountsPage } from "./pages/Accounts";
import { ActivitiesPage } from "./pages/Activities";
import { ApprovalsPage } from "./pages/Approvals";
import { CampaignsPage } from "./pages/Campaigns";
import { CalendarPage } from "./pages/Calendar";
import { ContactsPage } from "./pages/Contacts";
import { CrmSettingsPage } from "./pages/CrmSettings";
import { DashboardPage } from "./pages/Dashboard";
import { ExtensionAuthorizePage } from "./pages/ExtensionAuthorize";
import { HomeWorkspacePage } from "./pages/HomeWorkspace";
import { LoginPage } from "./pages/Login";
import { InboxPage } from "./pages/Inbox";
import { OpportunityDetailPage } from "./pages/OpportunityDetail";
import { PipelinePage } from "./pages/Pipeline";
import { ReportsPage } from "./pages/Reports";
import { SocialLeadsPage } from "./pages/SocialLeads";
import { StudioPage } from "./pages/Studio";
import { TasksPage } from "./pages/Tasks";
import { TeamPage } from "./pages/Team";

const ContentResearchPage = lazy(() =>
  import("./pages/ContentResearch").then((module) => ({ default: module.ContentResearchPage })),
);

function ResearchProtected({ children }: { children: React.ReactNode }) {
  const { data, loading } = useData<{ features: { contentResearch: boolean } }>("/public-config");
  if (loading)
    return (
      <div className="loading-page">
        <Spinner />
      </div>
    );
  if (!data?.features.contentResearch) return <Navigate to="/" replace />;
  return <ManagementProtected>{children}</ManagementProtected>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="loading-page">
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  return children;
}

function ManagementProtected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="loading-page">
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  if (user.role === "ic") return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route
        path="/inbox"
        element={
          <Protected>
            <InboxPage />
          </Protected>
        }
      />
      <Route
        path="/extension/authorize"
        element={
          <Protected>
            <ExtensionAuthorizePage />
          </Protected>
        }
      />
      <Route
        path="/"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      <Route
        path="/home/tasks"
        element={
          <Protected>
            <HomeWorkspacePage view="tasks" />
          </Protected>
        }
      />
      <Route
        path="/home/insights"
        element={
          <Protected>
            <HomeWorkspacePage view="insights" />
          </Protected>
        }
      />
      <Route
        path="/tasks"
        element={
          <Protected>
            <TasksPage view="list" />
          </Protected>
        }
      />
      <Route
        path="/tasks/board"
        element={
          <Protected>
            <TasksPage view="board" />
          </Protected>
        }
      />
      <Route
        path="/tasks/timeline"
        element={
          <Protected>
            <CalendarPage />
          </Protected>
        }
      />
      <Route path="/timeline" element={<Navigate to="/tasks/timeline" replace />} />
      <Route path="/calendar" element={<Navigate to="/tasks/timeline" replace />} />
      <Route
        path="/accounts"
        element={
          <Protected>
            <AccountsPage />
          </Protected>
        }
      />
      <Route
        path="/accounts/:id"
        element={
          <Protected>
            <AccountDetailPage />
          </Protected>
        }
      />
      <Route
        path="/contacts"
        element={
          <Protected>
            <ContactsPage />
          </Protected>
        }
      />
      <Route
        path="/pipeline"
        element={
          <Protected>
            <PipelinePage />
          </Protected>
        }
      />
      <Route
        path="/opportunities/:id"
        element={
          <Protected>
            <OpportunityDetailPage />
          </Protected>
        }
      />
      <Route
        path="/activities"
        element={
          <Protected>
            <ActivitiesPage />
          </Protected>
        }
      />
      <Route
        path="/social-leads"
        element={
          <Protected>
            <SocialLeadsPage />
          </Protected>
        }
      />
      <Route
        path="/campaigns"
        element={
          <Protected>
            <CampaignsPage />
          </Protected>
        }
      />
      <Route
        path="/studio"
        element={
          <Protected>
            <StudioPage />
          </Protected>
        }
      />
      <Route
        path="/content-research"
        element={
          <ResearchProtected>
            <Suspense
              fallback={
                <div className="loading-page">
                  <Spinner />
                </div>
              }
            >
              <ContentResearchPage />
            </Suspense>
          </ResearchProtected>
        }
      />
      <Route
        path="/approvals"
        element={
          <Protected>
            <ApprovalsPage />
          </Protected>
        }
      />
      <Route
        path="/agent-setup"
        element={
          <Protected>
            <AgentSetupPage />
          </Protected>
        }
      />
      <Route
        path="/reports"
        element={
          <ManagementProtected>
            <ReportsPage />
          </ManagementProtected>
        }
      />
      <Route
        path="/team"
        element={
          <ManagementProtected>
            <TeamPage />
          </ManagementProtected>
        }
      />
      <Route
        path="/crm-settings"
        element={
          <ManagementProtected>
            <CrmSettingsPage />
          </ManagementProtected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
