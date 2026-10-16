import MarkdownIt from "markdown-it";
import { useMemo, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

import { cx } from "../components/ui";

export type ResearchDocument = {
  slug: string;
  filename: string;
  title: string;
  shortTitle: string;
  description: string;
  group: "Start here" | "Evidence";
  order: number;
  related: string[];
  archival?: boolean;
};

export type ResearchIndex = {
  snapshot: { commit: string; shortCommit: string; cutoff: string };
  stats: {
    items: number;
    representedCompetitors: number;
    universeCompetitors: number;
    channels: number;
    patterns: number;
    capabilities: number;
    references: number;
  };
  evidenceTiers: { A: number; B: number; C: number };
  documents: ResearchDocument[];
  filters: {
    competitors: string[];
    channels: string[];
    featureSets: string[];
    evidenceQualities: string[];
  };
};

export type TableOfContentsItem = { id: string; level: number; label: string };

export type ResearchDocumentResponse = {
  document: ResearchDocument;
  content: string;
  tableOfContents: TableOfContentsItem[];
  related: ResearchDocument[];
  backlinks: ResearchDocument[];
};

export type ResearchReference = {
  id: string;
  label: string;
  displayPath: string;
  kind: "markdown" | "code" | "data" | "text" | "directory";
  language: string | null;
  filename: string | null;
  parentId: string | null;
  children?: string[];
};

export type ResearchReferenceResponse = {
  reference: ResearchReference;
  children: ResearchReference[];
  content: string;
  backlinks: ResearchDocument[];
};

export type ResearchItem = {
  id: string;
  row_number: string;
  competitor: string;
  feature_set: string;
  channel: string;
  published_at: string;
  published_timezone: string;
  url: string;
  title_or_hook: string;
  format: string;
  topic_pillar: string;
  cta: string;
  views: string;
  reactions: string;
  comments: string;
  shares: string;
  saves: string;
  raw_interactions_lower_bound: string;
  follower_or_subscriber_count: string;
  interactions_per_1000_followers: string;
  crosspost_group_id: string;
  source_report: string;
  source_reference_id: string;
  evidence_quality: string;
  caveat: string;
};

export type ResearchItemsResponse = {
  items: ResearchItem[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

function cleanHeading(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function headingSlug(value: string) {
  return cleanHeading(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function markdownRenderer() {
  const markdown = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: true,
    typographer: true,
  });
  const defaultHeadingOpen =
    markdown.renderer.rules.heading_open ??
    ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));
  const defaultLinkOpen =
    markdown.renderer.rules.link_open ??
    ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));

  markdown.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
    const raw = tokens[index + 1]?.content ?? "section";
    const base = headingSlug(raw);
    const renderEnvironment = environment ?? {};
    const counts = (renderEnvironment.slugCounts ??= new Map<string, number>()) as Map<
      string,
      number
    >;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    tokens[index].attrSet("id", count ? `${base}-${count + 1}` : base);
    return defaultHeadingOpen(tokens, index, options, environment, self);
  };

  markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    const token = tokens[index];
    const href = String(token.attrGet("href") ?? "");
    if (href.startsWith("/content-research?")) token.attrJoin("class", "research-garden-link");
    else if (href === "#unavailable-reference") {
      token.attrJoin("class", "research-unavailable-link");
      token.attrSet("aria-disabled", "true");
      token.attrSet("title", "This local provenance reference was not included in the snapshot.");
    } else if (/^https?:/i.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer noopener");
    }
    return defaultLinkOpen(tokens, index, options, environment, self);
  };

  markdown.renderer.rules.table_open = () =>
    '<div class="research-table-scroll" role="region" tabindex="0"><table>';
  markdown.renderer.rules.table_close = () => "</table></div>";
  return markdown;
}

const markdown = markdownRenderer();

export function ResearchMarkdown({ content, className }: { content: string; className?: string }) {
  const navigate = useNavigate();
  const html = useMemo(
    () =>
      markdown.render(
        content.replaceAll("(research-ref:unavailable)", "(#unavailable-reference)"),
        {
          slugCounts: new Map<string, number>(),
        },
      ),
    [content],
  );

  function handleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>("a");
    if (!anchor) return;
    if (anchor.getAttribute("href") === "#unavailable-reference") {
      event.preventDefault();
      return;
    }
    const url = new URL(anchor.href, window.location.href);
    if (url.origin === window.location.origin && url.pathname === "/content-research") {
      event.preventDefault();
      navigate(`${url.pathname}${url.search}${url.hash}`);
    }
  }

  return (
    <article
      className={cx("research-markdown", className)}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
