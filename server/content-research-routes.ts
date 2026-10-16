import { Hono } from "hono";
import { parse } from "csv-parse/sync";

import { requireAuth, requireRole } from "./auth.js";
import { config } from "./config.js";
import type { AppBindings, AppEnv } from "./types.js";

type ResearchDocument = {
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

type ResearchReference = {
  id: string;
  label: string;
  displayPath: string;
  kind: "markdown" | "code" | "data" | "text" | "directory";
  language: string | null;
  filename: string | null;
  parentId: string | null;
  children?: string[];
};

type ResearchItem = Record<string, string> & {
  id: string;
  row_number: string;
  source_reference_id: string;
};

const documents: ResearchDocument[] = [
  {
    slug: "reconciliation-status",
    filename: "reconciliation-status.md",
    title: "Competitor channel-audit reconciliation",
    shortTitle: "Reconciliation status",
    description: "Completion state, coverage, limitations, and intentionally deferred vendors.",
    group: "Start here",
    order: 1,
    related: ["competitor-universe", "master-evidence-register", "fresh-research-queue"],
  },
  {
    slug: "competitor-universe",
    filename: "competitor-universe.md",
    title: "Userorbit competitor channel-audit universe",
    shortTitle: "Competitor universe",
    description: "The 54-brand market universe organized across eight product feature families.",
    group: "Start here",
    order: 2,
    related: ["reconciliation-status", "userorbit-feature-map", "master-evidence-register"],
  },
  {
    slug: "master-item-register-summary",
    filename: "master-item-register-summary.md",
    title: "Master competitor channel item register summary",
    shortTitle: "Register summary",
    description: "A readable census of the 2,552 normalized items, channels, and evidence quality.",
    group: "Start here",
    order: 3,
    related: ["engagement-analysis", "master-evidence-register", "reconciliation-status"],
  },
  {
    slug: "engagement-analysis",
    filename: "engagement-analysis.md",
    title: "Competitor channel audit — engagement analysis",
    shortTitle: "Engagement analysis",
    description:
      "Comparable channel performance, metric coverage, leaders, and measurement limits.",
    group: "Start here",
    order: 4,
    related: [
      "master-item-register-summary",
      "content-pattern-catalog",
      "userorbit-channel-strategy",
    ],
  },
  {
    slug: "content-pattern-catalog",
    filename: "content-pattern-catalog.md",
    title: "Userorbit content-pattern catalog",
    shortTitle: "Content patterns",
    description: "Twenty-six reusable structures for hooks, proof, CTAs, and cross-channel reuse.",
    group: "Start here",
    order: 5,
    related: ["engagement-analysis", "userorbit-channel-strategy", "userorbit-feature-map"],
  },
  {
    slug: "userorbit-channel-strategy",
    filename: "userorbit-channel-strategy.md",
    title: "Userorbit channel strategy",
    shortTitle: "Channel strategy",
    description: "Prioritized channels, operating cadence, measurement gates, and the 90-day plan.",
    group: "Start here",
    order: 6,
    related: ["content-pattern-catalog", "engagement-analysis", "userorbit-feature-map"],
  },
  {
    slug: "userorbit-feature-map",
    filename: "userorbit-feature-map.md",
    title: "Userorbit product feature map",
    shortTitle: "Product proof map",
    description:
      "Sixty-six capabilities with repository evidence and safe public-claim boundaries.",
    group: "Start here",
    order: 7,
    related: ["userorbit-channel-strategy", "competitor-universe", "master-evidence-register"],
  },
  {
    slug: "master-evidence-register",
    filename: "master-evidence-register.md",
    title: "Master evidence register",
    shortTitle: "Evidence register",
    description: "Competitor-by-competitor sources, evidence tiers, coverage, and remaining gaps.",
    group: "Evidence",
    order: 8,
    related: ["reconciliation-status", "master-item-register-summary", "fresh-research-queue"],
  },
  {
    slug: "fresh-research-queue",
    filename: "fresh-research-queue.md",
    title: "Controlled fresh-research queue",
    shortTitle: "Research queue archive",
    description: "Closeout history, completed static research, and five deferred competitors.",
    group: "Evidence",
    order: 9,
    archival: true,
    related: ["reconciliation-status", "master-evidence-register", "competitor-universe"],
  },
];

const documentBySlug = new Map(documents.map((document) => [document.slug, document]));
type ResearchData = {
  documentContent: Map<string, string>;
  snapshot: {
    commit: string;
    referenceCount: number;
  };
  references: ResearchReference[];
  referenceById: Map<string, ResearchReference>;
  referenceByDisplayPath: Map<string, ResearchReference>;
  items: ResearchItem[];
};

type ResearchContext = {
  req: { url: string };
  env: AppBindings;
};

let researchDataPromise: Promise<ResearchData> | undefined;

async function readResearchAsset(context: ResearchContext, filename: string) {
  const assets = context.env.ASSETS;
  if (!assets) throw new Error("Research assets are not configured.");
  const response = await assets.fetch(new URL(`/content-research/${filename}`, context.req.url));
  if (!response.ok) throw new Error(`Research asset ${filename} could not be loaded.`);
  return response.text();
}

async function loadResearchData(context: ResearchContext) {
  if (!researchDataPromise) {
    researchDataPromise = (async () => {
      const [documentContents, snapshotText, referencesText, itemsText] = await Promise.all([
        Promise.all(documents.map((document) => readResearchAsset(context, document.filename))),
        readResearchAsset(context, "snapshot.json"),
        readResearchAsset(context, "references.json"),
        readResearchAsset(context, "master-item-register.csv"),
      ]);
      const documentContent = new Map(
        documents.map((document, index) => [document.slug, documentContents[index] ?? ""]),
      );
      const references = JSON.parse(referencesText) as ResearchReference[];
      const rawItems = parse(itemsText, { columns: true, skip_empty_lines: true }) as Record<
        string,
        string
      >[];
      const items = rawItems.map((item, index) => ({
        ...item,
        id: `item-${index + 1}`,
        row_number: String(index + 2),
        source_reference_id: item.source_report?.startsWith("research-ref:")
          ? item.source_report.slice("research-ref:".length)
          : "",
      }));
      return {
        documentContent,
        snapshot: JSON.parse(snapshotText) as ResearchData["snapshot"],
        references,
        referenceById: new Map(references.map((reference) => [reference.id, reference])),
        referenceByDisplayPath: new Map(
          references.map((reference) => [reference.displayPath.replaceAll("\\", "/"), reference]),
        ),
        items,
      };
    })();
  }
  return researchDataPromise;
}

function normalizePosix(value: string) {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
const unique = (items: ResearchItem[], key: string) =>
  [...new Set(items.map((item) => item[key]).filter((value) => value && value !== "N/A"))].sort(
    (left, right) => left.localeCompare(right),
  );

function headingText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function headingSlug(value: string) {
  return headingText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function tableOfContents(content: string) {
  const counts = new Map<string, number>();
  return [...content.matchAll(/^(#{2,4})\s+(.+)$/gm)].map((match) => {
    const base = headingSlug(match[2]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return {
      id: count ? `${base}-${count + 1}` : base,
      level: match[1].length,
      label: headingText(match[2]),
    };
  });
}

function resolveReferenceTarget(
  current: ResearchReference,
  rawTarget: string,
  referenceByDisplayPath: Map<string, ResearchReference>,
) {
  if (/^(https?:|mailto:)/i.test(rawTarget)) return rawTarget;
  if (rawTarget.startsWith("/content-research?")) return rawTarget;

  const unwrapped = rawTarget.replace(/^<|>$/g, "");
  const hashIndex = unwrapped.indexOf("#");
  const withoutHash = hashIndex >= 0 ? unwrapped.slice(0, hashIndex) : unwrapped;
  const hash = hashIndex >= 0 ? unwrapped.slice(hashIndex) : "";
  const lineMatch = withoutHash.match(/^(.*?):(\d+)$/);
  const withoutLine = lineMatch ? lineMatch[1] : withoutHash;
  const line = lineMatch?.[2] ?? "";

  let displayTarget = withoutLine.replaceAll("\\", "/");
  const codexMarker = "/Documents/Codex/";
  const repositoryMarker = "/Developer/userorbit/";
  if (displayTarget.includes(codexMarker)) {
    displayTarget = `research/${displayTarget.split(codexMarker)[1]}`;
  } else if (displayTarget.includes(repositoryMarker)) {
    displayTarget = `userorbit/${displayTarget.split(repositoryMarker)[1]}`;
  } else if (!displayTarget.startsWith("research/") && !displayTarget.startsWith("userorbit/")) {
    const currentParts = current.displayPath.replaceAll("\\", "/").split("/");
    currentParts.pop();
    displayTarget = normalizePosix([...currentParts, displayTarget].join("/"));
  }

  const target = referenceByDisplayPath.get(displayTarget.replace(/\/$/, ""));
  if (!target) return "research-ref:unavailable";
  const query = new URLSearchParams({ ref: target.id });
  if (line) query.set("line", line);
  return `/content-research?${query.toString()}${hash}`;
}

function rewriteReferenceLinks(
  reference: ResearchReference,
  content: string,
  referenceByDisplayPath: Map<string, ResearchReference>,
) {
  return content.replace(
    /(\[[^\]]+\]\()([^)]+)(\))/g,
    (_, prefix, target, suffix) =>
      `${prefix}${resolveReferenceTarget(reference, target, referenceByDisplayPath)}${suffix}`,
  );
}

function searchItem(item: ResearchItem, query: string) {
  if (!query) return true;
  return [
    item.competitor,
    item.channel,
    item.feature_set,
    item.title_or_hook,
    item.format,
    item.topic_pillar,
    item.cta,
    item.caveat,
  ].some((value) => value?.toLowerCase().includes(query));
}

function metricNumber(value: string) {
  if (!value || value === "N/A") return -1;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : -1;
}

export const contentResearchRoutes = new Hono<AppEnv>();
contentResearchRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (config.CONTENT_RESEARCH_ENABLED !== "true") {
    return context.json({ error: "Not found." }, 404);
  }
  await next();
});
contentResearchRoutes.use("*", requireAuth);
contentResearchRoutes.use("*", requireRole("manager"));

contentResearchRoutes.get("/", async (context) => {
  const data = await loadResearchData(context);
  return context.json({
    snapshot: {
      commit: data.snapshot.commit,
      shortCommit: data.snapshot.commit.slice(0, 10),
      cutoff: "2026-08-09",
    },
    stats: {
      items: data.items.length,
      representedCompetitors: unique(data.items, "competitor").length,
      universeCompetitors: 54,
      channels: unique(data.items, "channel").length,
      patterns: 26,
      capabilities: 66,
      references: data.references.length,
    },
    evidenceTiers: { A: 30, B: 19, C: 5 },
    documents,
    filters: {
      competitors: unique(data.items, "competitor"),
      channels: unique(data.items, "channel"),
      featureSets: unique(data.items, "feature_set"),
      evidenceQualities: unique(data.items, "evidence_quality"),
    },
  });
});

contentResearchRoutes.get("/documents/:slug", async (context) => {
  const data = await loadResearchData(context);
  const document = documentBySlug.get(context.req.param("slug"));
  if (!document) return context.json({ error: "Research document not found." }, 404);
  const content = data.documentContent.get(document.slug) ?? "";
  const backlinks = documents.filter(
    (candidate) =>
      candidate.slug !== document.slug &&
      data.documentContent.get(candidate.slug)?.includes(`?doc=${document.slug}`),
  );
  return context.json({
    document,
    content,
    tableOfContents: tableOfContents(content),
    related: document.related.map((slug) => documentBySlug.get(slug)).filter(Boolean),
    backlinks,
  });
});

contentResearchRoutes.get("/references/:id", async (context) => {
  const data = await loadResearchData(context);
  const reference = data.referenceById.get(context.req.param("id"));
  if (!reference) return context.json({ error: "Research reference not found." }, 404);
  const children = (reference.children ?? [])
    .map((id) => data.referenceById.get(id))
    .filter((child): child is ResearchReference => Boolean(child));
  const content = reference.filename
    ? await readResearchAsset(context, `references/${reference.filename}`)
    : "";
  const backlinks = documents.filter((document) =>
    data.documentContent.get(document.slug)?.includes(`?ref=${reference.id}`),
  );
  return context.json({
    reference,
    children,
    content:
      reference.kind === "markdown"
        ? rewriteReferenceLinks(reference, content, data.referenceByDisplayPath)
        : content,
    backlinks,
  });
});

contentResearchRoutes.get("/items", async (context) => {
  const data = await loadResearchData(context);
  const search = (context.req.query("search") ?? "").trim().toLowerCase();
  const competitor = context.req.query("competitor") ?? "";
  const channel = context.req.query("channel") ?? "";
  const featureSet = context.req.query("featureSet") ?? "";
  const evidenceQuality = context.req.query("evidenceQuality") ?? "";
  const metric = context.req.query("metric") ?? "";
  const sort = context.req.query("sort") ?? "recent";
  const page = Math.max(1, Number.parseInt(context.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    50,
    Math.max(10, Number.parseInt(context.req.query("pageSize") ?? "25", 10) || 25),
  );

  const filtered = data.items.filter(
    (item) =>
      searchItem(item, search) &&
      (!competitor || item.competitor === competitor) &&
      (!channel || item.channel === channel) &&
      (!featureSet || item.feature_set === featureSet) &&
      (!evidenceQuality || item.evidence_quality === evidenceQuality) &&
      (!metric ||
        (metric === "available"
          ? metricNumber(item.raw_interactions_lower_bound) >= 0 || metricNumber(item.views) >= 0
          : metricNumber(item.raw_interactions_lower_bound) < 0 && metricNumber(item.views) < 0)),
  );

  filtered.sort((left, right) => {
    if (sort === "competitor") {
      return (
        left.competitor.localeCompare(right.competitor) || left.channel.localeCompare(right.channel)
      );
    }
    if (sort === "interactions") {
      return (
        metricNumber(right.raw_interactions_lower_bound) -
        metricNumber(left.raw_interactions_lower_bound)
      );
    }
    if (sort === "evidence") {
      const qualityOrder = { high: 0, medium: 1, low: 2, "N/A": 3 } as Record<string, number>;
      return (
        (qualityOrder[left.evidence_quality] ?? 4) - (qualityOrder[right.evidence_quality] ?? 4)
      );
    }
    const leftDate = left.published_at === "N/A" ? "" : left.published_at;
    const rightDate = right.published_at === "N/A" ? "" : right.published_at;
    return rightDate.localeCompare(leftDate);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  return context.json({
    items: filtered.slice(start, start + pageSize),
    pagination: {
      page: currentPage,
      pageSize,
      totalItems: filtered.length,
      totalPages,
    },
  });
});
