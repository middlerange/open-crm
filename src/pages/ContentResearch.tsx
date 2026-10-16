import {
  ArrowRightIcon,
  BookWithBookmarkIcon,
  ChartIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileMarkdownIcon,
  GridIcon,
  InformationIcon,
  LinkIcon,
  SparklesIcon,
  WarningTriangleIcon,
} from "../components/icons";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  PageToolbar,
  SearchInput,
  Select,
  Spinner,
  cx,
} from "../components/ui";
import {
  ResearchMarkdown,
  type ResearchDocument,
  type ResearchDocumentResponse,
  type ResearchIndex,
  type ResearchItem,
  type ResearchItemsResponse,
  type ResearchReferenceResponse,
  type TableOfContentsItem,
} from "../lib/content-research";
import { useData } from "../lib/use-data";

const number = new Intl.NumberFormat("en-US");

function routeToDocument(slug: string) {
  return `/content-research?doc=${slug}`;
}

function badgeTone(value: string): "neutral" | "green" | "amber" | "red" | "blue" {
  if (value === "high") return "green";
  if (value === "medium") return "amber";
  if (value === "low") return "red";
  return "neutral";
}

function captured(value: string) {
  return value && value !== "N/A" ? value : "Not captured";
}

function ResearchToolbar({
  mode,
  snapshot,
}: {
  mode: "garden" | "reader" | "evidence" | "reference";
  snapshot: string;
}) {
  return (
    <PageToolbar className="research-page-toolbar" label="Content research views">
      <div className="research-view-links">
        <Link
          className={cx("research-view-link", mode === "garden" && "is-active")}
          to="/content-research"
        >
          <GridIcon size={14} /> Garden
        </Link>
        <Link
          className={cx("research-view-link", mode === "reader" && "is-active")}
          to={routeToDocument("reconciliation-status")}
        >
          <BookWithBookmarkIcon size={14} /> Library
        </Link>
        <Link
          className={cx("research-view-link", mode === "evidence" && "is-active")}
          to="/content-research?view=evidence"
        >
          <FileCsvIcon size={14} /> Evidence
        </Link>
      </div>
      <span className="research-snapshot-label">
        <span className="research-live-dot" /> Snapshot {snapshot}
      </span>
    </PageToolbar>
  );
}

function ResearchNavigation({
  currentDoc,
  mode,
  documents,
  mobile = false,
}: {
  currentDoc: string;
  mode: "garden" | "reader" | "evidence" | "reference";
  documents: ResearchDocument[];
  mobile?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = documents.filter((document) =>
    `${document.shortTitle} ${document.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const body = (
    <>
      <div className="research-library-search">
        <SearchInput
          value={query}
          onChange={setQuery}
          label="Filter research library"
          placeholder="Find a document…"
        />
      </div>
      <nav className="research-library-nav" aria-label="Research library">
        <Link
          className={cx(
            "research-library-item research-library-home",
            mode === "garden" && "is-active",
          )}
          to="/content-research"
          aria-current={mode === "garden" ? "page" : undefined}
        >
          <span className="research-document-icon">
            <SparklesIcon size={15} />
          </span>
          <span>
            <strong>Start here</strong>
            <small>Map of the complete audit</small>
          </span>
        </Link>
        {["Start here", "Evidence"].map((group) => {
          const groupDocuments = filtered.filter((document) => document.group === group);
          if (!groupDocuments.length) return null;
          return (
            <div className="research-library-group" key={group}>
              <span className="research-library-label">{group}</span>
              {groupDocuments.map((document) => (
                <Link
                  className={cx(
                    "research-library-item",
                    currentDoc === document.slug && "is-active",
                  )}
                  to={routeToDocument(document.slug)}
                  key={document.slug}
                  aria-current={currentDoc === document.slug ? "page" : undefined}
                >
                  <span className="research-document-number numeric">{document.order}</span>
                  <span>
                    <strong>{document.shortTitle}</strong>
                    <small>{document.description}</small>
                  </span>
                </Link>
              ))}
            </div>
          );
        })}
        <div className="research-library-group">
          <span className="research-library-label">Dataset</span>
          <Link
            className={cx("research-library-item", mode === "evidence" && "is-active")}
            to="/content-research?view=evidence"
            aria-current={mode === "evidence" ? "page" : undefined}
          >
            <span className="research-document-icon">
              <FileCsvIcon size={15} />
            </span>
            <span>
              <strong>Item register</strong>
              <small>Browse all 2,552 normalized records</small>
            </span>
          </Link>
        </div>
      </nav>
    </>
  );

  if (mobile) {
    return (
      <details className="research-mobile-library">
        <summary>
          <BookWithBookmarkIcon size={16} /> Browse the research library
          <ChevronRightIcon size={15} />
        </summary>
        <div>{body}</div>
      </details>
    );
  }
  return <aside className="research-library">{body}</aside>;
}

function StatCard({
  icon,
  value,
  label,
  detail,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="research-stat-card">
      <span className="research-stat-icon">{icon}</span>
      <span className="research-stat-value numeric">{value}</span>
      <strong>{label}</strong>
      <small>{detail}</small>
    </div>
  );
}

function GardenOverview({ index }: { index: ResearchIndex }) {
  const startDocuments = index.documents.filter((document) => document.group === "Start here");
  const gardenColumns = [
    {
      eyebrow: "01 · Establish",
      title: "What we know",
      detail: "Scope, completeness, and the market universe.",
      documents: ["reconciliation-status", "competitor-universe", "master-item-register-summary"],
    },
    {
      eyebrow: "02 · Interpret",
      title: "What works",
      detail: "Comparable engagement signals and reusable content structures.",
      documents: ["engagement-analysis", "content-pattern-catalog"],
    },
    {
      eyebrow: "03 · Apply",
      title: "What to do next",
      detail: "Channel priorities, cadence, product proof, and claim boundaries.",
      documents: ["userorbit-channel-strategy", "userorbit-feature-map"],
    },
  ];
  const bySlug = new Map(index.documents.map((document) => [document.slug, document]));

  return (
    <div className="research-overview">
      <header className="research-overview-hero">
        <div>
          <Badge tone="green">
            <CheckCircleIcon size={12} /> Audit reconciled
          </Badge>
          <h2>Turn competitor evidence into a repeatable content system.</h2>
          <p>
            Follow the research from coverage and raw observations through patterns, channel
            choices, and the product claims Userorbit can safely support.
          </p>
          <div className="research-hero-actions">
            <Link
              className="button button-primary button-medium"
              to={routeToDocument("reconciliation-status")}
            >
              Begin the guided read <ArrowRightIcon size={15} />
            </Link>
            <Link
              className="button button-secondary button-medium"
              to="/content-research?view=evidence"
            >
              Explore the raw register
            </Link>
          </div>
        </div>
        <div className="research-thesis-card">
          <span>Strategic loop</span>
          <strong>Collect → decide → communicate → guide → ask → inspect</strong>
          <p>
            Every recommended channel should connect durable knowledge to inspectable product proof.
          </p>
        </div>
      </header>

      <section className="research-stat-grid" aria-label="Research corpus statistics">
        <StatCard
          icon={<FileCsvIcon size={17} />}
          value={number.format(index.stats.items)}
          label="content records"
          detail="Normalized across the master register"
        />
        <StatCard
          icon={<GridIcon size={17} />}
          value={number.format(index.stats.universeCompetitors)}
          label="competitor brands"
          detail={`${index.stats.representedCompetitors} represented by item rows`}
        />
        <StatCard
          icon={<ChartIcon size={17} />}
          value={number.format(index.stats.channels)}
          label="normalized channels"
          detail="Kept separate when metrics are incompatible"
        />
        <StatCard
          icon={<LinkIcon size={17} />}
          value={number.format(index.stats.references)}
          label="linked references"
          detail="Reports, channel packs, and product proof"
        />
      </section>

      <section className="research-section">
        <div className="research-section-heading">
          <div>
            <span className="research-eyebrow">Knowledge map</span>
            <h2>Move from evidence to execution</h2>
          </div>
          <p>
            The links are directional, but every source includes related research and backlinks.
          </p>
        </div>
        <div className="research-garden-map">
          {gardenColumns.map((column, columnIndex) => (
            <div className="research-garden-column" key={column.title}>
              <div className="research-garden-column-heading">
                <span>{column.eyebrow}</span>
                <h3>{column.title}</h3>
                <p>{column.detail}</p>
              </div>
              <div className="research-garden-node-list">
                {column.documents.map((slug) => {
                  const document = bySlug.get(slug)!;
                  return (
                    <Link className="research-garden-node" to={routeToDocument(slug)} key={slug}>
                      <span className="research-document-number numeric">{document.order}</span>
                      <span>
                        <strong>{document.shortTitle}</strong>
                        <small>{document.description}</small>
                      </span>
                      <ChevronRightIcon size={14} />
                    </Link>
                  );
                })}
              </div>
              {columnIndex < gardenColumns.length - 1 ? (
                <span className="research-map-connector" aria-hidden="true">
                  <ArrowRightIcon size={16} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="research-overview-grid">
        <section className="research-reading-path">
          <div className="research-section-heading compact">
            <div>
              <span className="research-eyebrow">Recommended path</span>
              <h2>Seven documents, in order</h2>
            </div>
          </div>
          <div className="research-reading-list">
            {startDocuments.map((document) => (
              <Link
                to={routeToDocument(document.slug)}
                className="research-reading-item"
                key={document.slug}
              >
                <span className="research-reading-number numeric">
                  {String(document.order).padStart(2, "0")}
                </span>
                <span>
                  <strong>{document.shortTitle}</strong>
                  <small>{document.description}</small>
                </span>
                <ChevronRightIcon size={15} />
              </Link>
            ))}
          </div>
        </section>

        <aside className="research-evidence-health">
          <div>
            <span className="research-eyebrow">Evidence health</span>
            <h2>Coverage before confidence</h2>
            <p>
              Evidence tier measures source and identity coverage—not performance or metric
              completeness.
            </p>
          </div>
          <div className="research-tier-stack" aria-label="Evidence tiers">
            {Object.entries(index.evidenceTiers).map(([tier, count]) => (
              <div key={tier}>
                <span className={`research-tier research-tier-${tier.toLowerCase()}`}>
                  Tier {tier}
                </span>
                <strong className="numeric">{count}</strong>
                <small>
                  {tier === "A"
                    ? "strongest coverage"
                    : tier === "B"
                      ? "usable with gaps"
                      : "bounded evidence"}
                </small>
              </div>
            ))}
          </div>
          <div className="research-boundary-note">
            <WarningTriangleIcon size={16} />
            <p>
              Five vendors were intentionally deferred. “Not captured” is never zero, views are not
              interactions, and cross-post identity does not prove lift.
            </p>
          </div>
          <Link className="research-inline-link" to={routeToDocument("master-evidence-register")}>
            Inspect the evidence register <ArrowRightIcon size={14} />
          </Link>
        </aside>
      </div>

      <section className="research-proof-strip">
        <div>
          <span className="research-proof-value numeric">{index.stats.patterns}</span>
          <span>reusable content patterns</span>
        </div>
        <ArrowRightIcon size={16} aria-hidden="true" />
        <div>
          <span className="research-proof-value numeric">{index.stats.capabilities}</span>
          <span>product capabilities with claim boundaries</span>
        </div>
        <ArrowRightIcon size={16} aria-hidden="true" />
        <div>
          <span className="research-proof-value numeric">90</span>
          <span>days of executable channel work</span>
        </div>
      </section>
    </div>
  );
}

function TableOfContents({ items }: { items: TableOfContentsItem[] }) {
  return (
    <nav className="research-toc" aria-label="On this page">
      <span>On this page</span>
      {items.map((item) => (
        <a className={`research-toc-level-${item.level}`} href={`#${item.id}`} key={item.id}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function RelatedResearch({
  related,
  backlinks,
}: {
  related: ResearchDocument[];
  backlinks: ResearchDocument[];
}) {
  const links = [...related, ...backlinks].filter(
    (document, index, all) =>
      all.findIndex((candidate) => candidate.slug === document.slug) === index,
  );
  if (!links.length) return null;
  return (
    <section className="research-related">
      <div className="research-section-heading compact">
        <div>
          <span className="research-eyebrow">Keep exploring</span>
          <h2>Related research and backlinks</h2>
        </div>
      </div>
      <div className="research-related-grid">
        {links.map((document) => (
          <Link to={routeToDocument(document.slug)} key={document.slug}>
            <FileMarkdownIcon size={16} />
            <span>
              <strong>{document.shortTitle}</strong>
              <small>{document.description}</small>
            </span>
            <ChevronRightIcon size={14} />
          </Link>
        ))}
      </div>
    </section>
  );
}

function DocumentReader({ slug }: { slug: string }) {
  const { data, loading, error } = useData<ResearchDocumentResponse>(
    `/content-research/documents/${encodeURIComponent(slug)}`,
  );
  useEffect(() => {
    if (!data || !window.location.hash) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
    });
    return () => cancelAnimationFrame(frame);
  }, [data]);

  if (loading)
    return (
      <div className="research-loading">
        <Spinner />
      </div>
    );
  if (error || !data) {
    return (
      <EmptyState
        icon={<WarningTriangleIcon size={20} />}
        title="Unable to open this research document"
        description={error ?? "The document is not part of this snapshot."}
        action={
          <Link className="button button-secondary button-medium" to="/content-research">
            Return to the garden
          </Link>
        }
      />
    );
  }
  return (
    <div className="research-reader-layout">
      <main className="research-reader-main" id="research-content">
        <header className="research-document-intro">
          <div>
            <Badge tone={data.document.archival ? "amber" : "blue"}>
              {data.document.archival ? "Archive" : `Reading ${data.document.order} of 7`}
            </Badge>
            <p>{data.document.description}</p>
          </div>
          <span className="research-document-format">
            <FileMarkdownIcon size={14} /> Markdown source
          </span>
        </header>
        {data.document.archival ? (
          <div className="research-archive-banner">
            <InformationIcon size={17} />
            <p>
              This file preserves closeout history. Its older queue language is archival, not active
              work.
            </p>
          </div>
        ) : null}
        <details className="research-mobile-toc">
          <summary>
            On this page <ChevronRightIcon size={14} />
          </summary>
          <TableOfContents items={data.tableOfContents} />
        </details>
        <ResearchMarkdown content={data.content} />
        <RelatedResearch related={data.related} backlinks={data.backlinks} />
      </main>
      <aside className="research-reader-rail">
        <TableOfContents items={data.tableOfContents} />
        <div className="research-reader-context">
          <span>Evidence boundary</span>
          <p>
            Directional findings stay separate from measured facts. Follow linked sources before
            reusing a claim.
          </p>
        </div>
      </aside>
    </div>
  );
}

function CodeReference({ content, line }: { content: string; line: string }) {
  const lines = content.split("\n");
  useEffect(() => {
    if (!line) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(`source-line-${line}`)?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, [line]);
  return (
    <pre className="research-source-code" aria-label="Source file">
      <code>
        {lines.map((value, index) => {
          const lineNumber = String(index + 1);
          return (
            <span
              className={cx("research-source-line", line === lineNumber && "is-target")}
              id={`source-line-${lineNumber}`}
              key={lineNumber}
            >
              <span className="research-source-line-number">{lineNumber}</span>
              <span>{value || " "}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function ReferenceReader({ id, line }: { id: string; line: string }) {
  const { data, loading, error } = useData<ResearchReferenceResponse>(
    `/content-research/references/${encodeURIComponent(id)}`,
  );
  if (loading)
    return (
      <div className="research-loading">
        <Spinner />
      </div>
    );
  if (error || !data) {
    return (
      <EmptyState
        icon={<WarningTriangleIcon size={20} />}
        title="Reference unavailable"
        description={error ?? "This source is not part of the authenticated snapshot."}
        action={
          <Link className="button button-secondary button-medium" to="/content-research">
            Return to the garden
          </Link>
        }
      />
    );
  }
  const { reference } = data;
  return (
    <main className="research-reference-reader" id="research-content">
      <header className="research-reference-header">
        <span className="research-reference-icon">
          {reference.kind === "markdown" ? (
            <FileMarkdownIcon size={18} />
          ) : reference.kind === "data" ? (
            <FileCsvIcon size={18} />
          ) : (
            <FileCodeIcon size={18} />
          )}
        </span>
        <div>
          <Badge tone="purple">Linked evidence</Badge>
          <h2>{reference.label}</h2>
          <p>{reference.displayPath}</p>
        </div>
      </header>
      {reference.kind === "directory" ? (
        <section className="research-reference-directory">
          <div className="research-section-heading compact">
            <div>
              <span className="research-eyebrow">Channel evidence pack</span>
              <h2>{data.children.length} source files</h2>
            </div>
          </div>
          <div className="research-reference-list">
            {data.children.map((child) => (
              <Link to={`/content-research?ref=${child.id}`} key={child.id}>
                {child.kind === "markdown" ? (
                  <FileMarkdownIcon size={16} />
                ) : child.kind === "data" ? (
                  <FileCsvIcon size={16} />
                ) : (
                  <FileCodeIcon size={16} />
                )}
                <span>
                  <strong>{child.label}</strong>
                  <small>{child.displayPath}</small>
                </span>
                <ChevronRightIcon size={14} />
              </Link>
            ))}
          </div>
        </section>
      ) : reference.kind === "markdown" ? (
        <ResearchMarkdown content={data.content} className="research-reference-markdown" />
      ) : (
        <CodeReference content={data.content} line={line} />
      )}
      {data.backlinks.length ? <RelatedResearch related={[]} backlinks={data.backlinks} /> : null}
    </main>
  );
}

function EvidenceDetail({ item, onClose }: { item: ResearchItem | null; onClose: () => void }) {
  if (!item) return null;
  const metrics = [
    ["Views", item.views],
    ["Reactions", item.reactions],
    ["Comments", item.comments],
    ["Shares", item.shares],
    ["Saves", item.saves],
    ["Interaction lower bound", item.raw_interactions_lower_bound],
    ["Profile denominator", item.follower_or_subscriber_count],
    ["Interactions / 1k", item.interactions_per_1000_followers],
  ];
  return (
    <Modal
      open
      onClose={onClose}
      title={item.title_or_hook}
      description={`${item.competitor} · ${item.channel}`}
      footer={
        <>
          {item.source_reference_id ? (
            <Link
              className="button button-secondary button-medium"
              to={`/content-research?ref=${item.source_reference_id}`}
              onClick={onClose}
            >
              Source report
            </Link>
          ) : null}
          {item.url !== "N/A" ? (
            <a
              className="button button-primary button-medium"
              href={item.url}
              rel="noreferrer"
              target="_blank"
            >
              Open original <ExternalLinkIcon size={14} />
            </a>
          ) : null}
        </>
      }
    >
      <div className="research-item-detail">
        <div className="research-detail-badges">
          <Badge tone={badgeTone(item.evidence_quality)}>{item.evidence_quality} evidence</Badge>
          <Badge>{captured(item.published_at)}</Badge>
          {item.crosspost_group_id !== "N/A" ? <Badge tone="blue">Cross-post group</Badge> : null}
        </div>
        <dl className="research-detail-list">
          {[
            ["Feature set", item.feature_set],
            ["Format", item.format],
            ["Topic pillar", item.topic_pillar],
            ["Call to action", item.cta],
            ["Published timezone", item.published_timezone],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{captured(value)}</dd>
            </div>
          ))}
        </dl>
        <div className="research-metric-grid">
          {metrics.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong className="numeric">{captured(value)}</strong>
            </div>
          ))}
        </div>
        <div className="research-caveat">
          <InformationIcon size={16} />
          <div>
            <strong>Evidence caveat</strong>
            <p>{item.caveat}</p>
          </div>
        </div>
        <span className="research-row-provenance numeric">
          Master register row {item.row_number}
        </span>
      </div>
    </Modal>
  );
}

function EvidenceExplorer({
  index,
  params,
  setParams,
}: {
  index: ResearchIndex;
  params: URLSearchParams;
  setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void;
}) {
  const [selected, setSelected] = useState<ResearchItem | null>(null);
  const search = params.get("q") ?? "";
  const deferredSearch = useDeferredValue(search);
  const page = params.get("page") ?? "1";
  const competitor = params.get("competitor") ?? "";
  const channel = params.get("channel") ?? "";
  const featureSet = params.get("featureSet") ?? "";
  const evidenceQuality = params.get("quality") ?? "";
  const metric = params.get("metric") ?? "";
  const sort = params.get("sort") ?? "recent";

  const requestPath = useMemo(() => {
    const query = new URLSearchParams({ page, pageSize: "25", sort });
    if (deferredSearch) query.set("search", deferredSearch);
    if (competitor) query.set("competitor", competitor);
    if (channel) query.set("channel", channel);
    if (featureSet) query.set("featureSet", featureSet);
    if (evidenceQuality) query.set("evidenceQuality", evidenceQuality);
    if (metric) query.set("metric", metric);
    return `/content-research/items?${query.toString()}`;
  }, [channel, competitor, deferredSearch, evidenceQuality, featureSet, metric, page, sort]);
  const { data, loading, error } = useData<ResearchItemsResponse>(requestPath);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set("view", "evidence");
    next.delete("page");
    setParams(next, { replace: true });
  }

  function setPage(nextPage: number) {
    const next = new URLSearchParams(params);
    next.set("view", "evidence");
    next.set("page", String(nextPage));
    setParams(next);
  }

  return (
    <main className="research-evidence-view" id="research-content">
      <header className="research-evidence-intro">
        <div>
          <Badge tone="blue">Master register</Badge>
          <h2>Inspect every normalized content record.</h2>
          <p>
            Metrics remain in their native classes. “Not captured” is distinct from zero, and
            cross-post siblings are never summed.
          </p>
        </div>
        <span className="research-result-count numeric">
          {data ? number.format(data.pagination.totalItems) : "—"} results
        </span>
      </header>

      <div className="research-evidence-filters">
        <SearchInput
          className="research-evidence-search"
          value={search}
          onChange={(value) => setFilter("q", value)}
          label="Search evidence records"
          placeholder="Search titles, topics, CTAs…"
          loading={loading && deferredSearch !== search}
        />
        <Select
          value={competitor}
          onValueChange={(value) => setFilter("competitor", value)}
          aria-label="Filter by competitor"
        >
          <option value="">All competitors</option>
          {index.filters.competitors.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={channel}
          onValueChange={(value) => setFilter("channel", value)}
          aria-label="Filter by channel"
        >
          <option value="">All channels</option>
          {index.filters.channels.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={featureSet}
          onValueChange={(value) => setFilter("featureSet", value)}
          aria-label="Filter by feature set"
        >
          <option value="">All feature sets</option>
          {index.filters.featureSets.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={evidenceQuality}
          onValueChange={(value) => setFilter("quality", value)}
          aria-label="Filter by evidence quality"
        >
          <option value="">Any evidence quality</option>
          {index.filters.evidenceQualities.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={metric}
          onValueChange={(value) => setFilter("metric", value)}
          aria-label="Filter by metric availability"
        >
          <option value="">Any metric coverage</option>
          <option value="available">Public metric available</option>
          <option value="unavailable">No public metric captured</option>
        </Select>
        <Select
          value={sort}
          onValueChange={(value) => setFilter("sort", value)}
          aria-label="Sort evidence records"
        >
          <option value="recent">Most recent</option>
          <option value="interactions">Interaction lower bound</option>
          <option value="competitor">Competitor</option>
          <option value="evidence">Evidence quality</option>
        </Select>
      </div>

      {error ? (
        <EmptyState
          icon={<WarningTriangleIcon size={20} />}
          title="Unable to load evidence"
          description={error}
        />
      ) : loading && !data ? (
        <div className="research-loading">
          <Spinner />
        </div>
      ) : data?.items.length ? (
        <>
          <div className="table-surface research-evidence-table-wrap">
            <div className="data-table-wrap">
              <table className="data-table data-table-responsive research-evidence-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Channel</th>
                    <th>Published</th>
                    <th>Evidence</th>
                    <th>Metrics</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td data-cell="wide" data-label="Record">
                        <button
                          className="research-item-trigger"
                          type="button"
                          onClick={() => setSelected(item)}
                        >
                          <span className="table-title">{item.title_or_hook}</span>
                          <span className="table-secondary">
                            {item.competitor} · {item.feature_set}
                          </span>
                        </button>
                      </td>
                      <td data-label="Channel">
                        <span className="table-title">{item.channel}</span>
                        <span className="table-secondary">{captured(item.format)}</span>
                      </td>
                      <td className="table-muted-cell numeric" data-label="Published">
                        {captured(item.published_at)}
                      </td>
                      <td data-label="Evidence">
                        <Badge tone={badgeTone(item.evidence_quality)}>
                          {item.evidence_quality}
                        </Badge>
                      </td>
                      <td data-label="Metrics">
                        <span className="table-title numeric">
                          {captured(item.raw_interactions_lower_bound)}
                        </span>
                        <span className="table-secondary">interaction lower bound</span>
                      </td>
                      <td data-cell="actions">
                        <div className="table-actions">
                          <Button
                            size="icon"
                            variant="plain"
                            aria-label={`Inspect ${item.title_or_hook}`}
                            onClick={() => setSelected(item)}
                          >
                            <ChevronRightIcon size={15} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <nav className="research-pagination" aria-label="Evidence pages">
            <Button
              variant="plain"
              disabled={data.pagination.page <= 1}
              onClick={() => setPage(data.pagination.page - 1)}
            >
              <ChevronLeftIcon size={15} /> Previous
            </Button>
            <span className="numeric">
              Page {data.pagination.page} of {data.pagination.totalPages}
            </span>
            <Button
              variant="plain"
              disabled={data.pagination.page >= data.pagination.totalPages}
              onClick={() => setPage(data.pagination.page + 1)}
            >
              Next <ChevronRightIcon size={15} />
            </Button>
          </nav>
        </>
      ) : (
        <EmptyState
          icon={<FileCsvIcon size={20} />}
          title="No evidence matches these filters"
          description="Clear one or more filters to widen the register view."
          action={
            <Button onClick={() => setParams(new URLSearchParams({ view: "evidence" }))}>
              Clear filters
            </Button>
          }
        />
      )}
      <EvidenceDetail item={selected} onClose={() => setSelected(null)} />
    </main>
  );
}

export function ContentResearchPage() {
  const { data: index, loading, error } = useData<ResearchIndex>("/content-research");
  const [params, setParams] = useSearchParams();
  const documentSlug = params.get("doc") ?? "";
  const referenceId = params.get("ref") ?? "";
  const view = params.get("view") ?? "";
  const mode = referenceId
    ? "reference"
    : documentSlug
      ? "reader"
      : view === "evidence"
        ? "evidence"
        : "garden";
  const currentDocument = index?.documents.find((document) => document.slug === documentSlug);
  const title =
    currentDocument?.shortTitle ??
    (mode === "evidence"
      ? "Evidence explorer"
      : mode === "reference"
        ? "Source reference"
        : "Content research");

  return (
    <AppShell
      contentWidth="full"
      title={title}
      toolbar={
        index ? <ResearchToolbar mode={mode} snapshot={index.snapshot.shortCommit} /> : undefined
      }
    >
      {loading ? (
        <div className="research-loading">
          <Spinner />
        </div>
      ) : error || !index ? (
        <EmptyState
          icon={<WarningTriangleIcon size={20} />}
          title="Content research is unavailable"
          description={error ?? "The authenticated research snapshot could not be loaded."}
        />
      ) : (
        <div className="research-workspace">
          <ResearchNavigation currentDoc={documentSlug} mode={mode} documents={index.documents} />
          <div className="research-content-pane">
            <ResearchNavigation
              currentDoc={documentSlug}
              mode={mode}
              documents={index.documents}
              mobile
            />
            {mode === "reader" ? (
              <DocumentReader slug={documentSlug} />
            ) : mode === "reference" ? (
              <ReferenceReader id={referenceId} line={params.get("line") ?? ""} />
            ) : mode === "evidence" ? (
              <EvidenceExplorer index={index} params={params} setParams={setParams} />
            ) : (
              <GardenOverview index={index} />
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
