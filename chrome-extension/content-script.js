(() => {
  const PROFILE_SELECTOR = 'a[href*="linkedin.com/in/"], a[href^="/in/"]';
  const POST_SELECTOR =
    'article, [role="article"], [data-urn*="urn:li:activity"], [data-view-name="feed-full-update"], [data-view-name="feed-update"], .feed-shared-update-v2, .occludable-update';
  const ACTION_BAR_SELECTOR = [
    ".feed-shared-social-action-bar",
    "[data-view-name='feed-social-action-bar']",
    "[data-view-name='feed-social-actions']",
    "[data-view-name='feed-actions']",
  ].join(",");
  const COMMENT_SELECTOR = [
    ".comments-comment-entity",
    ".comments-comment-item",
    "[data-id^='urn:li:comment']",
    "[data-view-name='comment-container']",
  ].join(",");
  const MAX_ENGAGEMENTS = 500;
  const LOAD_SETTLE_MS = 400;
  const MAX_REACTION_LOAD_ROUNDS = 50;
  const MAX_COMMENT_LOAD_ROUNDS = 30;
  let activePost = null;
  let activePostUrl = "";
  let activePostKey = "";
  let activeButton = null;
  let observerQueued = false;
  const diagnostics = {
    discovered: 0,
    mounted: 0,
    missingActionRow: 0,
  };

  function cleanText(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function waitFor(getValue, timeout = 8_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await delay(100);
    }
    return null;
  }

  function canonicalUrl(value) {
    try {
      const url = new URL(value, location.origin);
      if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return "";
      url.hostname = "www.linkedin.com";
      url.protocol = "https:";
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      return url.toString().replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function isVisible(element) {
    if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function hasFeedPostHeading(root) {
    return [...(root?.querySelectorAll("h2") ?? [])].some(
      (heading) => cleanText(heading.textContent).toLowerCase() === "feed post",
    );
  }

  function postRoots() {
    const candidates = new Set(document.querySelectorAll(POST_SELECTOR));
    for (const heading of document.querySelectorAll("h2")) {
      if (cleanText(heading.textContent).toLowerCase() !== "feed post") continue;
      const post = heading.closest('[role="listitem"]');
      if (!post || !hasFeedPostHeading(post)) continue;
      const semanticActions = new Set(
        [...post.querySelectorAll("button, a")].map(actionKind).filter(Boolean),
      );
      if (
        semanticActions.size >= 3 ||
        post.querySelector('button[aria-label*="control menu for post by" i]')
      ) {
        candidates.add(post);
      }
    }

    const posts = [...candidates].filter((post) => {
      if (!isVisible(post)) return false;
      return ![...candidates].some((candidate) => candidate !== post && candidate.contains(post));
    });
    diagnostics.discovered = posts.length;
    document.documentElement.dataset.orbitHookDiagnostics = JSON.stringify(diagnostics);
    return posts;
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const element = root?.querySelector(selector);
      const value = cleanText(element?.textContent);
      if (value) return value;
    }
    return "";
  }

  function firstAttribute(root, selectors, attribute) {
    for (const selector of selectors) {
      const value = cleanText(root?.querySelector(selector)?.getAttribute(attribute));
      if (value) return value;
    }
    return "";
  }

  function parseCount(value) {
    const match = cleanText(value)
      .toLowerCase()
      .match(/([\d,.]+)\s*([km])?/);
    if (!match) return 0;
    const amount = Number.parseFloat(match[1].replaceAll(",", ""));
    if (!Number.isFinite(amount)) return 0;
    if (match[2] === "k") return Math.round(amount * 1_000);
    if (match[2] === "m") return Math.round(amount * 1_000_000);
    return Math.round(amount);
  }

  function countFrom(root, selectors, labels) {
    for (const selector of selectors) {
      for (const element of root?.querySelectorAll(selector) ?? []) {
        const value = cleanText(element.textContent || element.getAttribute("aria-label"));
        if (/\d/.test(value)) return parseCount(value);
      }
    }
    for (const element of root?.querySelectorAll("a, button, [aria-label]") ?? []) {
      const label = cleanText(
        `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`,
      );
      if (labels.some((word) => label.toLowerCase().includes(word)) && /\d/.test(label)) {
        return parseCount(label);
      }
    }
    return 0;
  }

  function profileUrl(anchor) {
    const url = canonicalUrl(anchor.href);
    if (!url) return "";
    return new URL(url).pathname.toLowerCase().startsWith("/in/") ? url : "";
  }

  function entityName(anchor, container) {
    const commentMenuLabel = firstAttribute(
      container,
      ['button[aria-label*="options for" i][aria-label*="comment" i]'],
      "aria-label",
    );
    const commentAuthor = commentMenuLabel.match(/options for\s+(.+?)[’']s comment/i)?.[1];
    if (commentAuthor) return cleanText(commentAuthor).slice(0, 160);

    const structured = firstText(container, [
      ".artdeco-entity-lockup__title",
      ".comments-comment-meta__description-title",
      ".comments-post-meta__name-text",
      "[data-view-name='comment-actor-name']",
    ]);
    if (structured)
      return structured
        .replace(/\s*View .* profile\s*/i, "")
        .trim()
        .slice(0, 160);

    const anchorText = cleanText(anchor.textContent)
      .replace(/\s*View .* profile\s*/i, "")
      .replace(/\s*•\s*(1st|2nd|3rd).*$/i, "")
      .trim();
    if (anchorText && anchorText.length <= 160) return anchorText;

    return cleanText(anchor.getAttribute("aria-label"))
      .replace(/^View\s+/i, "")
      .replace(/['’]s profile$/i, "")
      .trim()
      .slice(0, 160);
  }

  function entityHeadline(container) {
    const structured = firstText(container, [
      ".artdeco-entity-lockup__subtitle",
      ".comments-comment-meta__description-subtitle",
      ".comments-comment-meta__headline",
      "[data-view-name='comment-actor-headline']",
    ]);
    if (structured) return structured.slice(0, 500);

    const commentMenu = container?.querySelector(
      'button[aria-label*="options for" i][aria-label*="comment" i]',
    );
    if (!commentMenu) return "";
    return (
      [...container.querySelectorAll("p")]
        .filter(isVisible)
        .map((paragraph) => cleanText(paragraph.textContent))
        .filter(Boolean)[1]
        ?.slice(0, 500) ?? ""
    );
  }

  function entityMetadata(container) {
    const text = cleanText(container?.textContent);
    const headline = entityHeadline(container);
    const connectionDegree = text.match(/\b(1st|2nd|3rd)\b/i)?.[1] ?? "";
    const companyName =
      headline
        .match(/(?:^|\s)(?:at|@)\s+(.+?)(?:\s*[|·]|$)/i)?.[1]
        ?.trim()
        .slice(0, 180) ?? "";
    const location = firstText(container, [
      ".artdeco-entity-lockup__caption",
      ".artdeco-entity-lockup__metadata",
      "[data-view-name='person-location']",
    ]).slice(0, 180);
    return { companyName, connectionDegree, location };
  }

  function postPermalink(root) {
    const candidates = [
      ...root.querySelectorAll('a[href*="/feed/update/urn:li:activity:"], a[href*="/posts/"]'),
    ];
    const permalink = candidates
      .map((anchor) => canonicalUrl(anchor.href))
      .find((url) => /linkedin\.com\/(feed\/update\/urn:li:activity:|posts\/)/i.test(url));
    if (permalink) return permalink;
    const activityUrn = cleanText(
      root.getAttribute("data-urn") || root.querySelector("[data-urn]")?.getAttribute("data-urn"),
    ).match(/urn:li:activity:\d+/i)?.[0];
    if (activityUrn) return `https://www.linkedin.com/feed/update/${activityUrn}`;
    const current = canonicalUrl(location.href);
    return /linkedin\.com\/(feed\/update\/|posts\/)/i.test(current) ? current : "";
  }

  function postAuthor(root) {
    const menuLabel = firstAttribute(
      root,
      ['button[aria-label*="control menu for post by" i]'],
      "aria-label",
    );
    const menuAuthor = menuLabel.match(/control menu for post by\s+(.+?)\.?$/i)?.[1];
    if (menuAuthor) return cleanText(menuAuthor).slice(0, 160);

    const structured = firstText(root, [
      ".update-components-actor__name",
      ".feed-shared-actor__name",
      "[data-view-name='feed-full-update-actor'] strong",
      "[data-view-name='feed-full-update-actor'] span[aria-hidden='true']",
      "a[href*='/company/'] span[aria-hidden='true']",
    ]);
    if (structured) return structured.replace(/\s*View .* profile\s*/i, "").slice(0, 160);

    const profileAnchor = root.querySelector(PROFILE_SELECTOR);
    return profileAnchor
      ? entityName(profileAnchor, profileAnchor.parentElement).slice(0, 160)
      : "";
  }

  function postText(root) {
    const structured = firstText(root, [
      ".update-components-text",
      ".feed-shared-update-v2__description",
      "[data-view-name='feed-commentary']",
    ]);
    if (structured) return structured.slice(0, 10_000);

    const paragraphs = [...root.querySelectorAll("p")]
      .filter((paragraph) => isVisible(paragraph) && !paragraph.closest('[role="dialog"]'))
      .map((paragraph) => cleanText(paragraph.textContent))
      .filter(
        (text) =>
          text.length >= 20 &&
          !/^\d+[smhdw]\s*•?$/i.test(text) &&
          !/^(like|comment|repost|send)$/i.test(text) &&
          !/\b(reactions?|comments?|reposts?)\s*\d*$/i.test(text),
      );
    return (paragraphs.sort((left, right) => right.length - left.length)[0] ?? "").slice(0, 10_000);
  }

  function postPublishedAt(root) {
    const datetime = firstAttribute(root, ["time[datetime]"], "datetime");
    if (!datetime) return null;
    const date = new Date(datetime);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  function snapshotPost(root) {
    return {
      postKey: postKey(root),
      postUrl: postPermalink(root),
      postAuthorName: postAuthor(root),
      postText: postText(root),
      postPublishedAt: postPublishedAt(root),
      postReactionCount: countFrom(
        root,
        [
          ".social-details-social-counts__reactions-count",
          ".social-details-social-counts__reactions button",
          "[data-view-name='feed-reaction-count']",
        ],
        ["reaction", "like"],
      ),
      postCommentCount: countFrom(
        root,
        [
          ".social-details-social-counts__comments",
          "button[aria-label*='comment' i]",
          "[data-view-name='feed-comment-count']",
        ],
        ["comment"],
      ),
      postRepostCount: countFrom(
        root,
        [
          ".social-details-social-counts__reposts",
          "button[aria-label*='repost' i]",
          "[data-view-name='feed-repost-count']",
        ],
        ["repost"],
      ),
    };
  }

  function postKey(root) {
    const urn = cleanText(
      root.getAttribute("data-urn") || root.querySelector("[data-urn]")?.getAttribute("data-urn"),
    );
    if (urn) return urn;
    const componentKey = cleanText(root.getAttribute("componentkey"));
    if (componentKey) return componentKey;
    return `${postAuthor(root)}|${postText(root).slice(0, 240)}`;
  }

  function reactionType(container) {
    const values = [...container.querySelectorAll("[alt], [aria-label]")].flatMap((element) => [
      cleanText(element.getAttribute("alt")),
      cleanText(element.getAttribute("aria-label")),
    ]);
    const known = ["like", "celebrate", "support", "love", "insightful", "funny"];
    return (
      known.find((reaction) => values.some((value) => value.toLowerCase().includes(reaction))) ??
      "reaction"
    );
  }

  function reactionDialogs() {
    return [...document.querySelectorAll('dialog, [role="dialog"], .artdeco-modal')].filter(
      (dialog) => {
        if (!isVisible(dialog)) return false;
        const label = cleanText(
          `${dialog.getAttribute("aria-label") ?? ""} ${dialog.getAttribute("data-test-modal-title") ?? ""}`,
        );
        return /reactions?|likes?/i.test(label) || Boolean(dialog.querySelector(PROFILE_SELECTOR));
      },
    );
  }

  function collectReactions(dialog = reactionDialogs().at(-1)) {
    if (!dialog) {
      return {
        engagements: [],
        warning: "LinkedIn did not expose this post’s reactions list.",
      };
    }

    const engagements = [];
    for (const anchor of dialog.querySelectorAll(PROFILE_SELECTOR)) {
      if (!isVisible(anchor)) continue;
      const url = profileUrl(anchor);
      const container =
        anchor.closest("li, .artdeco-entity-lockup, [data-view-name]") ?? anchor.parentElement;
      const personName = entityName(anchor, container);
      if (!url || !personName) continue;
      engagements.push({
        personName,
        profileUrl: url,
        headline: entityHeadline(container),
        ...entityMetadata(container),
        engagementType: "reaction",
        reactionType: reactionType(container),
        commentText: "",
      });
    }
    return { engagements, warning: "" };
  }

  function mergeEngagements(target, engagements) {
    for (const engagement of engagements) {
      if (target.size >= MAX_ENGAGEMENTS) break;
      const key = engagementKey(engagement);
      if (!target.has(key)) target.set(key, engagement);
    }
  }

  function reactionTrigger(root) {
    const structured = root.querySelector(
      [
        ".social-details-social-counts__reactions-count",
        ".social-details-social-counts__reactions button",
        "[data-view-name='feed-reaction-count']",
      ].join(","),
    );
    if (structured && isVisible(structured)) {
      return structured.closest("button, a") ?? structured;
    }

    const expectedCount = snapshotPost(root).postReactionCount;
    return [...root.querySelectorAll("button, a")].find((candidate) => {
      if (!isVisible(candidate) || candidate.closest('dialog, [role="dialog"], .artdeco-modal'))
        return false;
      const label = actionLabel(candidate);
      if (/comment|repost|share|send/.test(label)) return false;
      if (/\d/.test(label) && /reactions?|likes?/.test(label)) return true;
      return (
        expectedCount > 0 &&
        parseCount(label) === expectedCount &&
        actionKind(candidate) !== "reaction"
      );
    });
  }

  function scrollableElement(root) {
    return [root, ...root.querySelectorAll("div, ul")]
      .filter((element) => element.scrollHeight > element.clientHeight + 8)
      .sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
  }

  function loadMoreControl(root, pattern) {
    return [...root.querySelectorAll("button, a")].find((candidate) => {
      if (!isVisible(candidate) || candidate.disabled) return false;
      return pattern.test(actionLabel(candidate));
    });
  }

  async function collectAllReactions(root, expectedCount) {
    const existingDialog = reactionDialogs().at(-1) ?? null;
    let dialog = existingDialog;
    let openedByOrbit = false;

    if (!dialog) {
      const trigger = reactionTrigger(root);
      if (!trigger) {
        return {
          engagements: [],
          warning: "LinkedIn did not expose a reactions control for this post.",
        };
      }
      trigger.click();
      dialog = await waitFor(() =>
        reactionDialogs().find((candidate) => candidate !== existingDialog),
      );
      openedByOrbit = Boolean(dialog);
    }

    if (!dialog) {
      return {
        engagements: [],
        warning:
          "LinkedIn did not open this post’s reactions list. Open the post permalink and try again.",
      };
    }

    const engagements = new Map();
    let stableRounds = 0;
    try {
      for (let round = 0; round < MAX_REACTION_LOAD_ROUNDS; round += 1) {
        const previousSize = engagements.size;
        mergeEngagements(engagements, collectReactions(dialog).engagements);
        if (
          engagements.size >= MAX_ENGAGEMENTS ||
          (expectedCount && engagements.size >= expectedCount)
        ) {
          break;
        }

        const loadMore = loadMoreControl(dialog, /load more|show more|see more|next/i);
        if (loadMore) loadMore.click();
        const scroller = scrollableElement(dialog);
        const wasAtEnd =
          !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        await delay(LOAD_SETTLE_MS);
        mergeEngagements(engagements, collectReactions(dialog).engagements);
        stableRounds =
          engagements.size === previousSize && wasAtEnd && !loadMore ? stableRounds + 1 : 0;
        if (stableRounds >= 3) break;
      }
    } finally {
      if (openedByOrbit) {
        const close =
          loadMoreControl(dialog, /^(close|dismiss)\b|close.*dialog|dismiss.*dialog/i) ??
          dialog.querySelector(".artdeco-modal__dismiss");
        close?.click();
      }
    }

    const people = [...engagements.values()];
    const incomplete = expectedCount > people.length && people.length < MAX_ENGAGEMENTS;
    return {
      engagements: people,
      warning: incomplete
        ? `LinkedIn loaded ${people.length} of ${expectedCount} reactions before the list stopped advancing.`
        : people.length >= MAX_ENGAGEMENTS
          ? `Orbit stopped at ${MAX_ENGAGEMENTS} engagement signals for this scan.`
          : "",
    };
  }

  function collectComments(postRoot) {
    const commentContainers = new Set(
      [...postRoot.querySelectorAll(COMMENT_SELECTOR)].filter(isVisible),
    );
    for (const menu of postRoot.querySelectorAll(
      'button[aria-label*="options for" i][aria-label*="comment" i]',
    )) {
      let container = menu.parentElement;
      while (container && container !== postRoot) {
        const paragraphs = [...container.querySelectorAll("p")].filter(isVisible);
        if (container.querySelector(PROFILE_SELECTOR) && paragraphs.length >= 4) {
          commentContainers.add(container);
          break;
        }
        container = container.parentElement;
      }
    }
    const engagements = [];
    for (const container of commentContainers) {
      const anchor = [...container.querySelectorAll(PROFILE_SELECTOR)].find(isVisible);
      if (!anchor) continue;
      const url = profileUrl(anchor);
      const personName = entityName(anchor, container);
      let commentText = firstText(container, [
        ".comments-comment-item__main-content",
        ".comments-comment-item-content-body",
        ".comments-comment-entity__content",
        "[data-view-name='comment-commentary']",
        ".update-components-text",
      ]);
      if (!commentText) {
        commentText = [...container.querySelectorAll("p")]
          .filter(isVisible)
          .map((paragraph) => cleanText(paragraph.textContent))
          .slice(3)
          .find(
            (text) =>
              text &&
              !/^\d+\s*(reactions?|replies?)?/i.test(text) &&
              !/^(like|reply|load more)$/i.test(text),
          );
      }
      commentText = cleanText(commentText).slice(0, 5_000);
      if (!url || !personName || !commentText) continue;
      engagements.push({
        personName,
        profileUrl: url,
        headline: entityHeadline(container),
        ...entityMetadata(container),
        engagementType: "comment",
        reactionType: "",
        commentText,
      });
    }
    return {
      engagements,
      warning: commentContainers.length ? "" : "LinkedIn did not expose comments for this post.",
    };
  }

  function commentDisclosure(root, expectedCount) {
    const structured = root.querySelector(
      [
        ".social-details-social-counts__comments",
        "[data-view-name='feed-comment-count']",
        "button[aria-label*='comments' i]",
        "a[aria-label*='comments' i]",
      ].join(","),
    );
    if (structured && isVisible(structured)) {
      return structured.closest("button, a") ?? structured;
    }
    return [...root.querySelectorAll("button, a")].find((candidate) => {
      if (!isVisible(candidate) || candidate.closest('dialog, [role="dialog"], .artdeco-modal'))
        return false;
      const label = actionLabel(candidate);
      if (/reactions?|likes?|repost|share|send/.test(label)) return false;
      return (
        (/\d/.test(label) && /comments?/.test(label)) ||
        (expectedCount > 0 && parseCount(label) === expectedCount && /comments?/.test(label))
      );
    });
  }

  async function collectAllComments(root, expectedCount) {
    const engagements = new Map();
    mergeEngagements(engagements, collectComments(root).engagements);

    if (expectedCount > engagements.size) {
      commentDisclosure(root, expectedCount)?.click();
      await delay(LOAD_SETTLE_MS);
    }

    for (let round = 0; round < MAX_COMMENT_LOAD_ROUNDS; round += 1) {
      const currentRoot = selectedPostRoot() ?? root;
      const previousSize = engagements.size;
      mergeEngagements(engagements, collectComments(currentRoot).engagements);
      if (
        engagements.size >= MAX_ENGAGEMENTS ||
        (expectedCount && engagements.size >= expectedCount)
      ) {
        break;
      }
      const loadMore = loadMoreControl(
        currentRoot,
        /load more comments|show (?:more|previous) comments|view (?:more|previous) comments|see more comments|previous comments/i,
      );
      if (!loadMore) break;
      loadMore.click();
      await delay(LOAD_SETTLE_MS);
      mergeEngagements(engagements, collectComments(selectedPostRoot() ?? currentRoot).engagements);
      if (engagements.size === previousSize && !loadMore.isConnected) break;
    }

    const comments = [...engagements.values()];
    const incomplete = expectedCount > comments.length && comments.length < MAX_ENGAGEMENTS;
    return {
      engagements: comments,
      warning: incomplete
        ? `LinkedIn loaded ${comments.length} of ${expectedCount} comments before pagination stopped.`
        : comments.length >= MAX_ENGAGEMENTS
          ? `Orbit stopped at ${MAX_ENGAGEMENTS} engagement signals for this scan.`
          : "",
    };
  }

  function engagementKey(engagement) {
    return [
      engagement.profileUrl.toLowerCase(),
      engagement.engagementType,
      cleanText(engagement.commentText).toLowerCase(),
    ].join("|");
  }

  function deduplicate(engagements) {
    const unique = new Map();
    for (const engagement of engagements) {
      const key = engagementKey(engagement);
      if (!unique.has(key)) unique.set(key, engagement);
    }
    return [...unique.values()];
  }

  function bestVisiblePost() {
    const posts = postRoots();
    return (
      posts.find((post) => {
        const rect = post.getBoundingClientRect();
        return rect.top >= 0 && rect.top < innerHeight * 0.6;
      }) ??
      posts[0] ??
      null
    );
  }

  async function scan(root, mode) {
    if (!root) throw new Error("No LinkedIn post is visible on this page.");
    const post = snapshotPost(root);
    const results = [];
    const warnings = [];
    if (!post.postUrl) {
      warnings.push(
        "Open this post in its own page once so Orbit can capture a stable source URL.",
      );
    }
    if (mode === "reactions" || mode === "both") {
      const reactions = await collectAllReactions(root, post.postReactionCount);
      results.push(...reactions.engagements);
      if (reactions.warning) warnings.push(reactions.warning);
    }
    if (mode === "comments" || mode === "both") {
      const comments = await collectAllComments(selectedPostRoot() ?? root, post.postCommentCount);
      results.push(...comments.engagements);
      if (comments.warning) warnings.push(comments.warning);
    }
    return { ...post, engagements: deduplicate(results), warnings };
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function selectedPostRoot() {
    if (activePost?.isConnected) return activePost;
    if (activePostKey) {
      const matchingPost = postRoots().find((post) => postKey(post) === activePostKey);
      if (matchingPost) {
        activePost = matchingPost;
        return matchingPost;
      }
    }
    if (activePostUrl) {
      const matchingPost = postRoots().find((post) => postPermalink(post) === activePostUrl);
      if (matchingPost) {
        activePost = matchingPost;
        return matchingPost;
      }
    }
    return bestVisiblePost();
  }

  function actionLabel(button) {
    return cleanText(
      [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].join(
        " ",
      ),
    ).toLowerCase();
  }

  function actionKind(element) {
    const label = actionLabel(element);
    if (/reaction button state|\b(like|react)\b/.test(label)) return "reaction";
    if (/\bcomment\b/.test(label)) return "comment";
    if (/\brepost\b/.test(label)) return "repost";
    if (/\bsend\b|\bshare\b/.test(label)) return "send";
    return "";
  }

  function fallbackActionBar(post) {
    const actions = [...post.querySelectorAll("button, a")].filter(
      (element) => isVisible(element) && actionKind(element),
    );
    const containers = new Set();
    for (const action of actions) {
      let container = action.parentElement;
      while (container && container !== post) {
        const kinds = new Set(
          actions.filter((candidate) => container.contains(candidate)).map(actionKind),
        );
        if (kinds.size >= 3) containers.add(container);
        container = container.parentElement;
      }
    }
    return (
      [...containers].sort((left, right) => {
        const interactiveDifference =
          left.querySelectorAll("button, a").length - right.querySelectorAll("button, a").length;
        if (interactiveDifference) return interactiveDifference;
        return cleanText(left.textContent).length - cleanText(right.textContent).length;
      })[0] ?? null
    );
  }

  function postActionBar(post) {
    return post.querySelector(ACTION_BAR_SELECTOR) ?? fallbackActionBar(post);
  }

  function showButtonError(button, message) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.title = message;
    button.setAttribute("aria-pressed", "false");
    const label = button.querySelector("[data-orbit-label]");
    if (label) label.textContent = "Try again";
    setTimeout(() => {
      if (!button.isConnected) return;
      button.title = "Open this post in the Orbit lead collector";
      if (label) label.textContent = "Find leads";
    }, 2_500);
  }

  function mountPost(post) {
    if (post.querySelector(":scope .orbit-lead-hook")) return;
    const actionBar = postActionBar(post);
    const hook = document.createElement("span");
    hook.className = "orbit-lead-hook";
    hook.dataset.orbitPostKey = postKey(post);
    hook.dataset.orbitPlacement = actionBar ? "action-row" : "fallback";

    const button = document.createElement("button");
    button.className = "orbit-lead-action";
    button.type = "button";
    button.title = "Open this post in the Orbit lead collector";
    button.setAttribute("aria-label", "Open this LinkedIn post in the Orbit lead collector");
    button.setAttribute("aria-pressed", "false");
    const mark = document.createElement("img");
    mark.src = chrome.runtime.getURL("orbit-mark.svg");
    mark.alt = "";
    mark.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.dataset.orbitLabel = "";
    label.textContent = "Find leads";
    button.append(mark, label);

    hook.append(button);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeButton && activeButton !== button) {
        activeButton.setAttribute("aria-pressed", "false");
        const previousLabel = activeButton.querySelector("[data-orbit-label]");
        if (previousLabel) previousLabel.textContent = "Find leads";
      }
      activeButton = button;
      activePost = post;
      activePostUrl = postPermalink(post);
      activePostKey = postKey(post);
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      label.textContent = "Opening…";
      reactionTrigger(post)?.click();
      void send({ type: "ORBIT_OPEN_SIDE_PANEL", target: snapshotPost(post), autoCollect: true })
        .then((response) => {
          if (!response?.ok) {
            showButtonError(button, response?.error || "Could not open the Orbit side panel.");
            return;
          }
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.setAttribute("aria-pressed", "true");
          label.textContent = "Selected";
        })
        .catch(() => showButtonError(button, "Could not open the Orbit side panel."));
    });
    if (actionBar) {
      const actionContainer = actionBar.parentElement;
      const actionContainerKinds = new Set(
        [...(actionContainer?.querySelectorAll("button, a") ?? [])].map(actionKind).filter(Boolean),
      );
      const mountAnchor =
        actionContainer &&
        actionContainer !== post &&
        actionContainerKinds.size >= 3 &&
        cleanText(actionContainer.textContent).length < 100
          ? actionContainer
          : actionBar;
      mountAnchor.append(hook);
    } else {
      diagnostics.missingActionRow += 1;
      const heading = [...post.querySelectorAll("h2")].find(
        (candidate) => cleanText(candidate.textContent).toLowerCase() === "feed post",
      );
      if (heading) heading.insertAdjacentElement("afterend", hook);
      else post.prepend(hook);
    }
    diagnostics.mounted += 1;
    document.documentElement.dataset.orbitHookDiagnostics = JSON.stringify(diagnostics);
  }

  function mountVisiblePosts() {
    observerQueued = false;
    if (activePost && !activePost.isConnected) activePost = null;
    if (activeButton && !activeButton.isConnected) activeButton = null;
    for (const post of postRoots()) mountPost(post);
  }

  function queueMount() {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(mountVisiblePosts);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ORBIT_LINKEDIN_CONTEXT") {
      const post = selectedPostRoot();
      if (!post) {
        sendResponse({ ok: false, error: "No LinkedIn post is visible on this page." });
      } else {
        sendResponse({ ok: true, result: snapshotPost(post) });
      }
      return true;
    }
    if (message?.type === "ORBIT_SCAN_LINKEDIN") {
      void scan(selectedPostRoot(), message.mode)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Unable to scan this page.",
          }),
        );
      return true;
    }
    return false;
  });

  new MutationObserver(queueMount).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addEventListener("scroll", queueMount, { capture: true, passive: true });
  addEventListener("resize", queueMount, { passive: true });
  addEventListener("popstate", queueMount);
  queueMount();
})();
