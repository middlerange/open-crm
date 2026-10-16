import {
  AppsIcon as Chrome,
  BuildingsIcon as BriefcaseBusiness,
  ChatBubbleIcon as MessageCircle,
  CheckIcon as Check,
  CloseIcon as X,
  ExternalLinkIcon as ExternalLink,
  ThumbsUpIcon as ThumbsUp,
  UserLinkIcon as UserRoundSearch,
} from "../components/icons";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AppShell } from "../components/shell";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Modal,
  PageToolbar,
  Panel,
  SearchInput,
  Select,
  Spinner,
  useToast,
} from "../components/ui";
import { api, formatDate, titleCase } from "../lib/api";
import { useData } from "../lib/use-data";

type Engagement = {
  id: string;
  personName: string;
  profileUrl: string;
  headline: string | null;
  engagementType: "reaction" | "comment";
  reactionType: string | null;
  commentText: string | null;
  status: "new" | "reviewed" | "dismissed";
  postUrl: string;
  postAuthorName: string | null;
  competitorName: string | null;
  capturedAt: string;
  ownerName: string;
  postsEngaged: number;
  intentScore: number;
  postText: string | null;
  postPublishedAt: string | null;
};

type EngagementResponse = {
  engagements: Engagement[];
  summary: { total: number; new: number; reactions: number; comments: number };
};

type LinkedInSource = {
  id: string;
  postUrl: string;
  postAuthorName: string | null;
  competitorName: string | null;
  postText: string | null;
  reactionCount: number;
  commentCount: number;
  repostCount: number;
  captureRuns: number;
  signalCount: number;
  peopleCount: number;
  lastCapturedAt: string;
  ownerName: string;
};

type ExtensionToken = {
  id: string;
  label: string;
  tokenPrefix: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

function engagementStatusTone(status: Engagement["status"]) {
  if (status === "new") return "blue" as const;
  if (status === "reviewed") return "green" as const;
  return "neutral" as const;
}

function intentTone(score: number) {
  if (score >= 75) return "purple" as const;
  if (score >= 60) return "blue" as const;
  return "neutral" as const;
}

function tokenUsageLabel(token: ExtensionToken) {
  if (!token.active) return "Revoked";
  if (!token.lastUsedAt) return "Never used";
  return `Used ${formatDate(token.lastUsedAt, true)}`;
}

export function SocialLeadsPage() {
  const { data, loading, reload } = useData<EngagementResponse>("/linkedin/engagements");
  const { data: tokenData, reload: reloadTokens } = useData<{ tokens: ExtensionToken[] }>(
    "/linkedin/tokens",
  );
  const { data: sourceData } = useData<{ sources: LinkedInSource[] }>("/linkedin/sources");
  const { notify } = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);

  const engagements = useMemo(
    () =>
      (data?.engagements ?? []).filter((engagement) => {
        const haystack =
          `${engagement.personName} ${engagement.headline ?? ""} ${engagement.competitorName ?? ""} ${engagement.postAuthorName ?? ""} ${engagement.commentText ?? ""}`.toLowerCase();
        return (
          (!search || haystack.includes(search.toLowerCase())) &&
          (!type || engagement.engagementType === type) &&
          (!status || engagement.status === status)
        );
      }),
    [data, search, status, type],
  );

  async function updateStatus(id: string, nextStatus: Engagement["status"]) {
    try {
      await api(`/linkedin/engagements/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      notify(nextStatus === "dismissed" ? "Lead signal dismissed." : "Lead signal reviewed.");
      await reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update this lead.", "error");
    }
  }

  async function qualifyInCrm(engagement: Engagement) {
    const nameParts = engagement.personName.trim().split(/\s+/);
    const firstName = nameParts.shift() ?? engagement.personName;
    const lastName = nameParts.join(" ");
    const sourceName = engagement.competitorName || engagement.postAuthorName || "LinkedIn post";
    const signal =
      engagement.engagementType === "comment"
        ? `commented: “${engagement.commentText ?? ""}”`
        : `reacted (${engagement.reactionType || "reaction"})`;
    await updateStatus(engagement.id, "reviewed");
    navigate("/accounts", {
      state: {
        leadPrefill: {
          source: `LinkedIn engagement · ${sourceName}`,
          evidenceSummary: `${engagement.personName} ${signal} on a post from ${sourceName}.`,
          triggerSummary: `Captured from competitor-post engagement on ${formatDate(engagement.capturedAt, true)}. Intent score: ${engagement.intentScore}/100.`,
          sourceLinks: `${engagement.postUrl}\n${engagement.profileUrl}`,
          contactFirstName: firstName,
          contactLastName: lastName,
          contactTitle: engagement.headline ?? "",
          contactLinkedin: engagement.profileUrl,
        },
      },
    });
  }

  async function revokeToken(id: string) {
    try {
      await api(`/linkedin/tokens/${id}`, { method: "DELETE" });
      notify("Extension token revoked.");
      await reloadTokens();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to revoke the token.", "error");
    }
  }

  const summary = data?.summary ?? { total: 0, new: 0, reactions: 0, comments: 0 };
  const hasSignals = Boolean(data?.engagements.length);
  const hasFilters = Boolean(search || type || status);

  return (
    <AppShell
      actions={
        !loading && hasSignals ? (
          <Button variant="primary" onClick={() => setSetupOpen(true)}>
            <Chrome size={15} /> Set up extension
          </Button>
        ) : null
      }
      toolbar={
        <PageToolbar className="table-toolbar" label="Search and filter social leads">
          <SearchInput
            className="table-toolbar-search"
            value={search}
            onChange={setSearch}
            placeholder="Search people, companies, or comments…"
          />
          <div className="table-toolbar-controls">
            <Select aria-label="Filter by engagement type" value={type} onValueChange={setType}>
              <option value="">All engagement</option>
              <option value="reaction">Reactions</option>
              <option value="comment">Comments</option>
            </Select>
            <Select aria-label="Filter by review state" value={status} onValueChange={setStatus}>
              <option value="">All states</option>
              <option value="new">New</option>
              <option value="reviewed">Reviewed</option>
              <option value="dismissed">Dismissed</option>
            </Select>
          </div>
        </PageToolbar>
      }
      contentWidth="wide"
    >
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">New signals</div>
          <div className="stat-value">{summary.new}</div>
          <div className="stat-detail">Awaiting manual review</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Reactions</div>
          <div className="stat-value">{summary.reactions}</div>
          <div className="stat-detail">Visible people captured</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Comments</div>
          <div className="stat-value">{summary.comments}</div>
          <div className="stat-detail">Higher-intent conversations</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{summary.total}</div>
          <div className="stat-detail">Deduplicated signals</div>
        </div>
      </div>

      <Panel className="table-surface" flush>
        {loading ? (
          <div className="loading-page loading-section">
            <Spinner />
          </div>
        ) : engagements.length ? (
          <div className="data-table-wrap">
            <table
              className="data-table data-table-responsive social-leads-table"
              aria-label="Social leads"
            >
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Signal</th>
                  <th>Source post</th>
                  <th>Owner</th>
                  <th>State</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {engagements.map((engagement) => (
                  <tr key={engagement.id}>
                    <td data-cell="primary">
                      <a
                        className="table-identity"
                        href={engagement.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Avatar name={engagement.personName} size="medium" />
                        <span className="table-identity-copy">
                          <span className="table-title social-lead-name">
                            {engagement.personName} <ExternalLink size={12} />
                          </span>
                          <span className="table-secondary">
                            {engagement.headline || "No headline captured"}
                          </span>
                        </span>
                      </a>
                    </td>
                    <td data-cell="wide" data-label="Signal">
                      <div className="social-signal-type">
                        {engagement.engagementType === "comment" ? (
                          <MessageCircle size={14} />
                        ) : (
                          <ThumbsUp size={14} />
                        )}
                        {engagement.engagementType === "comment"
                          ? "Comment"
                          : titleCase(engagement.reactionType || "reaction")}
                        <Badge tone={intentTone(engagement.intentScore)}>
                          {engagement.intentScore} intent
                        </Badge>
                      </div>
                      {engagement.commentText ? (
                        <div className="social-comment">“{engagement.commentText}”</div>
                      ) : null}
                      {engagement.postsEngaged > 1 ? (
                        <div className="table-secondary">
                          Engaged with {engagement.postsEngaged} captured posts
                        </div>
                      ) : null}
                    </td>
                    <td data-cell="wide" data-label="Source">
                      <a href={engagement.postUrl} target="_blank" rel="noreferrer">
                        <div className="table-title social-lead-name">
                          {engagement.competitorName ||
                            engagement.postAuthorName ||
                            "LinkedIn post"}{" "}
                          <ExternalLink size={12} />
                        </div>
                        <div className="table-secondary">
                          Captured {formatDate(engagement.capturedAt, true)}
                        </div>
                      </a>
                    </td>
                    <td className="table-muted-cell" data-label="Owner">
                      {engagement.ownerName}
                    </td>
                    <td data-label="State">
                      <Badge tone={engagementStatusTone(engagement.status)}>
                        {titleCase(engagement.status)}
                      </Badge>
                    </td>
                    <td data-cell="actions">
                      <div className="table-actions">
                        {engagement.status !== "dismissed" ? (
                          <Button
                            size="icon"
                            variant="plain"
                            aria-label={`Qualify ${engagement.personName} into CRM`}
                            onClick={() => void qualifyInCrm(engagement)}
                          >
                            <BriefcaseBusiness size={15} />
                          </Button>
                        ) : null}
                        {engagement.status !== "reviewed" ? (
                          <Button
                            size="icon"
                            variant="plain"
                            aria-label={`Mark ${engagement.personName} reviewed`}
                            onClick={() => void updateStatus(engagement.id, "reviewed")}
                          >
                            <Check size={15} />
                          </Button>
                        ) : null}
                        {engagement.status !== "dismissed" ? (
                          <Button
                            size="icon"
                            variant="plain"
                            aria-label={`Dismiss ${engagement.personName}`}
                            onClick={() => void updateStatus(engagement.id, "dismissed")}
                          >
                            <X size={15} />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<UserRoundSearch size={20} />}
            title={hasFilters ? "No matching social leads" : "No engagement signals yet"}
            description={
              hasFilters
                ? "Try another search or clear the engagement filters."
                : "Install the extension, open a LinkedIn post, and scan the reactions or comments currently visible on screen."
            }
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setSearch("");
                    setType("");
                    setStatus("");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setSetupOpen(true)}>
                  <Chrome size={15} /> Set up extension
                </Button>
              )
            }
          />
        )}
      </Panel>

      {(sourceData?.sources ?? []).length ? (
        <section
          className="table-surface social-source-section"
          aria-labelledby="tracked-sources-title"
        >
          <div className="panel-header">
            <div>
              <h2 id="tracked-sources-title">Tracked source posts</h2>
              <p>Re-scan a source to collect newly visible engagement without duplicates.</p>
            </div>
          </div>
          <div className="data-table-wrap">
            <table
              className="data-table data-table-responsive social-sources-table"
              aria-label="Tracked source posts"
            >
              <thead>
                <tr>
                  <th>Source post</th>
                  <th>Visible engagement</th>
                  <th>Captured leads</th>
                  <th>Last scan</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {sourceData?.sources.slice(0, 8).map((source) => (
                  <tr key={source.id}>
                    <td data-cell="primary">
                      <a
                        className="table-identity"
                        href={source.postUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="table-identity-mark" aria-hidden="true">
                          {(source.competitorName || source.postAuthorName || "LinkedIn post")
                            .trim()
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                        <span className="table-identity-copy">
                          <span className="table-title social-lead-name">
                            {source.competitorName || source.postAuthorName || "LinkedIn post"}{" "}
                            <ExternalLink size={12} />
                          </span>
                          <span className="table-secondary social-source-copy">
                            {source.postText || "Post text was not visible when captured."}
                          </span>
                        </span>
                      </a>
                    </td>
                    <td data-cell="wide" data-label="Engagement">
                      {source.reactionCount.toLocaleString()} reactions ·{" "}
                      {source.commentCount.toLocaleString()} comments
                    </td>
                    <td data-label="Captured leads">
                      <div className="table-title">{source.peopleCount} people</div>
                      <div className="table-secondary">
                        {source.signalCount} signals · {source.captureRuns} scans
                      </div>
                    </td>
                    <td className="table-muted-cell" data-label="Last scan">
                      {formatDate(source.lastCapturedAt, true)}
                    </td>
                    <td className="table-muted-cell" data-label="Owner">
                      {source.ownerName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <Modal
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
        }}
        title="Set up the Chrome extension"
        description="Sign in with your existing Orbit session. Your password never enters the extension."
      >
        <div className="extension-setup">
          <div className="setup-step">
            <span>1</span>
            <div>
              <strong>Load the extension</strong>
              <p>
                Open chrome://extensions, enable Developer mode, choose Load unpacked, and select
                the configured extension folder supplied by your workspace administrator.
              </p>
            </div>
          </div>
          <div className="extension-risk-note">
            LinkedIn currently states that browser extensions may not scrape or copy member data.
            User-triggered, visible-only capture reduces automation but does not remove that stated
            platform risk. Validate internal or public distribution with counsel and LinkedIn.
          </div>
          <div className="setup-step">
            <span>2</span>
            <div>
              <strong>Reload LinkedIn and use Orbit leads</strong>
              <p>
                Use the extension configured for this workspace. If you are signed in here, it
                connects automatically. Otherwise, choose its single Log in to Orbit button.
              </p>
            </div>
          </div>
          <div className="setup-step">
            <span>3</span>
            <div>
              <strong>Collect from the post itself</strong>
              <p>
                Choose Orbit leads beneath any LinkedIn post. Expand and scroll comments or the
                reactions list yourself, then scan, filter, select, export, or save the visible
                people from the post drawer.
              </p>
            </div>
          </div>
          {(tokenData?.tokens ?? []).length ? (
            <div className="token-list">
              <strong>Browser tokens</strong>
              {tokenData?.tokens.map((token) => (
                <div className="token-row" key={token.id}>
                  <div>
                    <span>{token.label}</span>
                    <small>
                      {token.tokenPrefix} · {tokenUsageLabel(token)}
                    </small>
                  </div>
                  {token.active ? (
                    <Button size="small" variant="plain" onClick={() => void revokeToken(token.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Modal>
    </AppShell>
  );
}
