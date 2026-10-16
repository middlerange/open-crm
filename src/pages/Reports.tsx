import {
  ChartIcon as BarChart3,
  CompassIcon as Target,
  ShieldLockIcon as LockKeyhole,
  UsersIcon as Users,
  WarningTriangleIcon as AlertTriangle,
} from "../components/icons";
import { Link } from "react-router-dom";

import { AppShell } from "../components/shell";
import { Avatar, Badge, Button, EmptyState, Panel, Spinner } from "../components/ui";
import { roleLabel } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/use-data";

type Dashboard = {
  summaries: {
    tasks: { open: number; overdue: number; doneThisWeek: number };
    accounts: { total: number; pending: number; active: number };
    activities: { today: number; thisWeek: number };
    approvals: { pending: number };
  };
  pipeline: Array<{ key: string; name: string; count: number; value: string }>;
  goals: Array<{
    id: string;
    label: string;
    target: number;
    actual: number;
    ownerName: string;
    periodEnd: string;
  }>;
};
type Team = {
  members: Array<{
    id: string;
    name: string;
    role: string;
    openTasks: number;
    overdueTasks: number;
    accounts: number;
  }>;
};
type CrmReports = {
  summary: {
    openCount: number;
    openValue: string;
    weightedValue: string;
    wonThisMonth: number;
    wonValueThisMonth: string;
    winRate: string;
    averageWonDeal: string;
    averageCycleDays: string;
  };
  byStage: Array<{
    id: string;
    name: string;
    probability: number;
    count: number;
    value: string;
    weightedValue: string;
    averageAgeDays: string;
  }>;
  closingSoon: Array<{
    id: string;
    name: string;
    accountName: string;
    valueAmount: string | null;
    currency: string;
    expectedCloseAt: string;
    stageName: string;
    ownerName: string | null;
  }>;
  overdue: Array<{
    id: string;
    name: string;
    accountName: string;
    nextAction: string;
    nextActionAt: string;
    stageName: string;
    ownerName: string | null;
  }>;
  trend: Array<{ month: string; created: number; won: number }>;
};

export function ReportsPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useData<Dashboard>("/dashboard");
  const { data: team } = useData<Team>("/team");
  const { data: crm } = useData<CrmReports>("/crm/reports");
  if (user?.role === "ic")
    return (
      <AppShell>
        <EmptyState
          icon={<LockKeyhole size={20} />}
          title="Management view"
          description="Team-wide performance is visible to Leads."
        />
      </AppShell>
    );
  if (error && !data)
    return (
      <AppShell>
        <EmptyState
          icon={<AlertTriangle size={19} />}
          title="Reports unavailable"
          description={error}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      </AppShell>
    );
  if (loading || !data)
    return (
      <AppShell>
        <div className="loading-page loading-section-tall">
          <Spinner />
        </div>
      </AppShell>
    );
  const owners = data.goals.reduce<Record<string, Dashboard["goals"]>>((groups, goal) => {
    (groups[goal.ownerName] ??= []).push(goal);
    return groups;
  }, {});
  const money = (value: string | number, currency = "USD") =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(Number(value));

  return (
    <AppShell
      contentWidth="wide"
      actions={
        <Badge tone={data.summaries.tasks.overdue ? "red" : "green"}>
          {data.summaries.tasks.overdue} overdue
        </Badge>
      }
    >
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            Open work{" "}
            <span className="stat-icon">
              <Target size={15} />
            </span>
          </div>
          <div className="stat-value">{data.summaries.tasks.open}</div>
          <div className="stat-detail">{data.summaries.tasks.doneThisWeek} completed this week</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Accounts{" "}
            <span className="stat-icon">
              <Users size={15} />
            </span>
          </div>
          <div className="stat-value">{data.summaries.accounts.total}</div>
          <div className="stat-detail">
            {data.summaries.accounts.pending} waiting for lead approval
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Activity this week{" "}
            <span className="stat-icon">
              <BarChart3 size={15} />
            </span>
          </div>
          <div className="stat-value">{data.summaries.activities.thisWeek}</div>
          <div className="stat-detail">{data.summaries.activities.today} recorded today</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Approval queue</div>
          <div className="stat-value">{data.summaries.approvals.pending}</div>
          <div className="stat-detail">Lead and campaign quality gates</div>
        </div>
      </div>
      {crm ? (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Open pipeline</div>
              <div className="stat-value">{money(crm.summary.openValue)}</div>
              <div className="stat-detail">{crm.summary.openCount} opportunities</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Weighted pipeline</div>
              <div className="stat-value">{money(crm.summary.weightedValue)}</div>
              <div className="stat-detail">Stage-probability weighted</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Won this month</div>
              <div className="stat-value">{money(crm.summary.wonValueThisMonth)}</div>
              <div className="stat-detail">{crm.summary.wonThisMonth} closed-won</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">90-day win rate</div>
              <div className="stat-value">{Math.round(Number(crm.summary.winRate))}%</div>
              <div className="stat-detail">
                {Math.round(Number(crm.summary.averageCycleDays))}d average won cycle
              </div>
            </div>
          </div>
          <div className="dashboard-grid">
            <Panel className="table-surface" flush>
              <div className="panel-header">
                <div>
                  <h2>Pipeline health</h2>
                  <p>Value, weighting, and average age in each stage.</p>
                </div>
              </div>
              <div className="data-table-wrap">
                <table
                  className="data-table data-table-responsive report-table"
                  aria-label="Pipeline health"
                >
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Deals</th>
                      <th>Value</th>
                      <th>Weighted</th>
                      <th>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crm.byStage.map((stage) => (
                      <tr key={stage.id}>
                        <td className="table-title" data-cell="primary">
                          {stage.name}
                        </td>
                        <td className="numeric" data-label="Deals">
                          {stage.count}
                        </td>
                        <td className="numeric" data-label="Value">
                          {money(stage.value)}
                        </td>
                        <td className="numeric" data-label="Weighted">
                          {money(stage.weightedValue)}
                        </td>
                        <td className="numeric" data-label="Age">
                          {Math.round(Number(stage.averageAgeDays))}d
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel flush>
              <div className="panel-header">
                <div>
                  <h2>Created vs won</h2>
                  <p>Six-month opportunity movement.</p>
                </div>
              </div>
              <div className="list">
                {crm.trend.map((point) => (
                  <div className="list-row" key={point.month}>
                    <div className="list-row-main">
                      <div className="list-row-title">
                        <span>{point.month}</span>
                      </div>
                    </div>
                    <span>{point.created} created</span>
                    <Badge tone="green">{point.won} won</Badge>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <div className="dashboard-grid">
            <Panel flush>
              <div className="panel-header">
                <div>
                  <h2>Closing in 30 days</h2>
                  <p>Expected decisions that need inspection.</p>
                </div>
              </div>
              {crm.closingSoon.length ? (
                <div className="list">
                  {crm.closingSoon.map((item) => (
                    <Link className="list-row" key={item.id} to={`/opportunities/${item.id}`}>
                      <div className="list-row-main">
                        <div className="list-row-title">
                          <span>{item.name}</span>
                          <Badge>{item.stageName}</Badge>
                        </div>
                        <div className="list-row-meta">
                          <span>{item.accountName}</span>
                          <span>{item.ownerName ?? "Unassigned"}</span>
                        </div>
                      </div>
                      <span>{money(item.valueAmount ?? 0, item.currency)}</span>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="Nothing closing soon"
                  description="Add expected close dates to active opportunities."
                />
              )}
            </Panel>
            <Panel flush>
              <div className="panel-header">
                <div>
                  <h2>Overdue next actions</h2>
                  <p>Open opportunities without a current commitment.</p>
                </div>
              </div>
              {crm.overdue.length ? (
                <div className="list">
                  {crm.overdue.map((item) => (
                    <Link className="list-row" key={item.id} to={`/opportunities/${item.id}`}>
                      <div className="list-row-main">
                        <div className="list-row-title">
                          <span>{item.name}</span>
                          <Badge tone="red">Overdue</Badge>
                        </div>
                        <div className="list-row-meta">
                          <span>{item.nextAction}</span>
                          <span>{item.ownerName ?? "Unassigned"}</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No overdue deal actions"
                  description="Every open opportunity has a current next step."
                />
              )}
            </Panel>
          </div>
        </>
      ) : null}
      <div className="dashboard-grid">
        <Panel className="table-surface" flush>
          <div className="panel-header">
            <div>
              <h2>Workload by owner</h2>
              <p>Enough visibility to rebalance before work becomes late.</p>
            </div>
          </div>
          <div className="data-table-wrap">
            <table
              className="data-table data-table-responsive report-table"
              aria-label="Workload by owner"
            >
              <thead>
                <tr>
                  <th>Team member</th>
                  <th>Role</th>
                  <th>Accounts</th>
                  <th>Open work</th>
                  <th>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {team?.members.map((member) => (
                  <tr key={member.id}>
                    <td data-cell="primary">
                      <div className="table-identity">
                        <Avatar name={member.name} size="medium" />
                        <span className="table-identity-copy">
                          <span className="table-title">{member.name}</span>
                          <span className="table-secondary">Team member</span>
                        </span>
                      </div>
                    </td>
                    <td data-label="Role">
                      <Badge
                        tone={
                          member.role === "manager"
                            ? "purple"
                            : member.role === "founder"
                              ? "blue"
                              : "neutral"
                        }
                      >
                        {roleLabel(member.role)}
                      </Badge>
                    </td>
                    <td className="numeric" data-label="Accounts">
                      {member.accounts}
                    </td>
                    <td className="numeric" data-label="Open work">
                      {member.openTasks}
                    </td>
                    <td
                      className={member.overdueTasks ? "numeric overdue" : "numeric"}
                      data-label="Overdue"
                    >
                      {member.overdueTasks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel flush>
          <div className="panel-header">
            <div>
              <h2>Funnel distribution</h2>
              <p>Accepted opportunities by current stage.</p>
            </div>
          </div>
          <div className="list">
            {data.pipeline.map((stage) => (
              <div className="list-row" key={stage.key}>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span>{stage.name}</span>
                  </div>
                </div>
                <span className="numeric">{stage.count}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel className="table-surface" flush>
        <div className="panel-header">
          <div>
            <h2>Target scorecards</h2>
            <p>Targets are editable planning defaults; actuals come from recorded work.</p>
          </div>
        </div>
        <div className="data-table-wrap">
          <table
            className="data-table data-table-responsive report-table"
            aria-label="Target scorecards"
          >
            <thead>
              <tr>
                <th>Owner</th>
                <th>Metric</th>
                <th>Actual</th>
                <th>Target</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(owners).flatMap(([owner, goals]) =>
                goals.map((goal) => {
                  const percent = Math.min(
                    100,
                    goal.target ? (goal.actual / goal.target) * 100 : 0,
                  );
                  return (
                    <tr key={goal.id}>
                      <td data-cell="primary">
                        <div className="table-identity">
                          <Avatar name={owner} size="medium" />
                          <span className="table-identity-copy">
                            <span className="table-title">{owner}</span>
                            <span className="table-secondary">Goal owner</span>
                          </span>
                        </div>
                      </td>
                      <td className="table-title" data-cell="wide" data-label="Metric">
                        {goal.label}
                      </td>
                      <td className="numeric" data-label="Actual">
                        {goal.actual}
                      </td>
                      <td className="numeric" data-label="Target">
                        {goal.target}
                      </td>
                      <td className="goal-progress-cell" data-cell="wide" data-label="Progress">
                        <progress className="progress-track" value={percent} max={100} />
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AppShell>
  );
}
