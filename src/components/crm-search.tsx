import { CommandIcon as Command, SearchIcon as Search } from "./icons";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, titleCase } from "../lib/api";
import { Badge, Button, EmptyState, Modal, SearchInput, Spinner } from "./ui";

type SearchResult = {
  id: string;
  type: "account" | "contact" | "opportunity" | "activity";
  title: string;
  subtitle: string | null;
  status: string | null;
  accountId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
};

type SearchResponse = {
  results: {
    accounts: SearchResult[];
    contacts: SearchResult[];
    opportunities: SearchResult[];
    activities: SearchResult[];
  };
};

function resultPath(result: SearchResult) {
  if (result.type === "account") return `/accounts/${result.id}`;
  if (result.type === "contact") return `/contacts?contact=${result.id}`;
  if (result.type === "opportunity") return `/opportunities/${result.id}`;
  if (result.opportunityId) return `/opportunities/${result.opportunityId}`;
  if (result.accountId) return `/accounts/${result.accountId}`;
  return "/activities";
}

export function CrmQuickSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (!open || normalized.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api<SearchResponse>(`/search?q=${encodeURIComponent(normalized)}`, {
          signal: controller.signal,
        });
        setResults([
          ...response.results.accounts,
          ...response.results.contacts,
          ...response.results.opportunities,
          ...response.results.activities,
        ]);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Search failed.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, query]);

  const grouped = useMemo(
    () =>
      (["account", "contact", "opportunity", "activity"] as const)
        .map((type) => ({ type, items: results.filter((result) => result.type === type) }))
        .filter((group) => group.items.length),
    [results],
  );

  function close() {
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  return (
    <>
      <Button
        className="global-search-trigger"
        aria-label="Search CRM"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
      >
        <Search size={16} /> Search
        <kbd className="global-search-shortcut" aria-hidden="true">
          <Command size={12} />
          <span>K</span>
        </kbd>
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Search Orbit"
        description="Find accounts, contacts, opportunities, and activity."
      >
        <div className="stack-list">
          <SearchInput
            className="global-search-input"
            value={query}
            onChange={setQuery}
            placeholder="Search CRM records…"
            label="Search all CRM records"
            loading={loading}
          />
          {query.trim().length < 2 ? (
            <EmptyState
              icon={<Search size={20} />}
              title="Search your CRM"
              description="Enter at least two characters. Results follow your workspace and owner access."
            />
          ) : error ? (
            <EmptyState title="Search unavailable" description={error} />
          ) : loading && !results.length ? (
            <div className="loading-page loading-section-compact">
              <Spinner />
            </div>
          ) : grouped.length ? (
            <div className="search-results">
              {grouped.map((group) => (
                <section key={group.type}>
                  <div className="nav-section-label">{titleCase(group.type)}s</div>
                  <div className="list">
                    {group.items.map((result) => (
                      <Link
                        className="list-row search-result-row"
                        key={`${result.type}-${result.id}`}
                        to={resultPath(result)}
                        onClick={close}
                      >
                        <span className="stat-icon">
                          <Search size={14} />
                        </span>
                        <span className="list-row-main">
                          <span className="list-row-title">
                            <span>{result.title}</span>
                            {result.status ? <Badge>{titleCase(result.status)}</Badge> : null}
                          </span>
                          <span className="list-row-meta">{result.subtitle || "No context"}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No CRM matches"
              description="Try a company, buyer, opportunity, email, or activity keyword."
            />
          )}
        </div>
      </Modal>
    </>
  );
}
