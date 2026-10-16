import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  GearIcon,
  InboxIcon,
  MailIcon,
  PaperAirplaneIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  ReplyIcon,
  StarFilledIcon,
  StarOutlineIcon,
  StaticTrashIcon,
  UnreadSquareBadgeIcon,
} from "../components/icons";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { AppShell } from "../components/shell";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  SearchInput,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "../components/ui";
import { ApiError, api, formatDate } from "../lib/api";
import { useAuth } from "../lib/auth";
import type {
  MailConversation,
  MailConversationList,
  MailConversationSummary,
  MailAttachment,
  MailDraft,
  MailDraftInput,
  MailFolder,
  MailSendResult,
  MailMessage,
  MailSetup,
} from "../lib/mail-types";
import { useData } from "../lib/use-data";
import "../inbox.css";

type ComposerState = {
  mode: "new" | "reply" | "forward" | "draft";
  forwardMessageId?: string;
  draftId: string | null;
  conversationId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  deliveryUncertain: boolean;
  attachments: MailAttachment[];
};

const EMPTY_COMPOSER: ComposerState = {
  mode: "new",
  draftId: null,
  conversationId: null,
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  idempotencyKey: "",
  deliveryUncertain: false,
  attachments: [],
};

function newComposer(): ComposerState {
  return { ...EMPTY_COMPOSER, idempotencyKey: crypto.randomUUID() };
}

const FOLDERS: Array<{ value: MailFolder; label: string; icon: typeof InboxIcon }> = [
  { value: "inbox", label: "Inbox", icon: InboxIcon },
  { value: "sent", label: "Sent", icon: PaperAirplaneIcon },
  { value: "drafts", label: "Drafts", icon: PencilIcon },
  { value: "archive", label: "Archive", icon: ArchiveIcon },
];

function addresses(value: string) {
  return value
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sender(summary: MailConversationSummary) {
  const first = summary.participants[0];
  return first?.name || first?.email || "Unknown sender";
}

function deliveryLabel(status: MailConversationSummary["deliveryStatus"]) {
  if (status === "uncertain") return "Delivery unknown";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  if (status === "queued") return "Queued";
  return null;
}

export function InboxPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const {
    data: setup,
    loading: setupLoading,
    error: setupError,
    reload: reloadSetup,
  } = useData<MailSetup>("/mail/setup");
  const [mailboxId, setMailboxId] = useState("");
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<MailConversation | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [list, setList] = useState<MailConversationList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [savingMailbox, setSavingMailbox] = useState(false);
  const [mailboxSettings, setMailboxSettings] = useState({
    displayName: "",
    signature: "",
    replyTo: "",
    enabled: true,
  });
  const [mailboxForm, setMailboxForm] = useState({
    localPart: "",
    domain: "",
    displayName: "",
    kind: "shared" as "private" | "shared",
    ownerId: "",
  });

  useEffect(() => {
    if (!mailboxId && setup?.mailboxes[0]) setMailboxId(setup.mailboxes[0].id);
  }, [mailboxId, setup]);

  const query = useMemo(() => {
    if (!mailboxId) return null;
    const params = new URLSearchParams({ mailboxId, folder, page: String(page), pageSize: "50" });
    if (search.trim()) params.set("search", search.trim());
    if (unreadOnly) params.set("unread", "true");
    if (starredOnly) params.set("starred", "true");
    return `/mail/conversations?${params}`;
  }, [folder, mailboxId, page, search, starredOnly, unreadOnly]);
  const latestForwardableMessage = conversation?.messages
    .slice()
    .reverse()
    .find((message) => ["received", "sent", "queued"].includes(message.status));
  const composerTitles = {
    new: "New message",
    reply: "Reply",
    forward: "Forward message",
    draft: "Edit draft",
  };
  const selectedSummary = list?.conversations.find((item) => item.id === selectedId) ?? null;
  const canManage = user?.role === "founder" || user?.role === "manager";
  const activeMailbox = setup?.mailboxes.find((mailbox) => mailbox.id === mailboxId);
  const canEditActiveMailbox = Boolean(
    activeMailbox &&
    (canManage || (activeMailbox.kind === "private" && activeMailbox.ownerId === user?.id)),
  );

  useEffect(() => {
    if (!activeMailbox) return;
    setMailboxSettings({
      displayName: activeMailbox.displayName,
      signature: activeMailbox.signature,
      replyTo: activeMailbox.replyTo ?? "",
      enabled: activeMailbox.enabled,
    });
  }, [activeMailbox]);

  useEffect(() => {
    setSelectedId(null);
    setConversation(null);
  }, [folder, mailboxId, page]);

  useEffect(() => {
    setPage(1);
  }, [folder, mailboxId, search, starredOnly, unreadOnly]);

  useEffect(() => {
    if (!query) {
      setList(null);
      setListLoading(false);
      return;
    }
    let active = true;
    setListLoading(true);
    setListError(null);
    api<MailConversationList>(query)
      .then((next) => {
        if (!active) return;
        if (next.pagination.page > next.pagination.pages) {
          setPage(Math.max(1, next.pagination.pages));
          return;
        }
        setList(next);
      })
      .catch(
        (caught) =>
          active && setListError(caught instanceof Error ? caught.message : "Unable to load mail."),
      )
      .finally(() => active && setListLoading(false));
    return () => {
      active = false;
    };
  }, [listRevision, query]);

  function reloadList() {
    setListRevision((revision) => revision + 1);
  }

  useEffect(() => {
    if (!selectedId || !mailboxId) return;
    let active = true;
    setConversationLoading(true);
    api<{ conversation: MailConversation }>(
      `/mail/conversations/${encodeURIComponent(selectedId)}?mailboxId=${encodeURIComponent(mailboxId)}`,
    )
      .then(({ conversation: next }) => {
        if (!active) return;
        setConversation(next);
        if (next.unread) void updateState(next, { read: true }, false);
      })
      .catch(
        (caught) =>
          active &&
          notify(
            caught instanceof Error ? caught.message : "Unable to open conversation.",
            "error",
          ),
      )
      .finally(() => active && setConversationLoading(false));
    return () => {
      active = false;
    };
  }, [mailboxId, selectedId]);

  async function updateState(
    item: MailConversationSummary,
    state: { read?: boolean; starred?: boolean; archived?: boolean },
    announce = true,
  ) {
    try {
      await api(`/mail/conversations/${item.id}/state`, {
        method: "PATCH",
        body: JSON.stringify({ mailboxId, ...state }),
      });
      setConversation((current) =>
        current?.id === item.id
          ? {
              ...current,
              unread: state.read === undefined ? current.unread : !state.read,
              starred: state.starred ?? current.starred,
              archived: state.archived ?? current.archived,
            }
          : current,
      );
      if (state.archived !== undefined) {
        setSelectedId(null);
        setConversation(null);
      }
      reloadList();
      await reloadSetup();
      if (announce) notify(state.archived ? "Conversation archived." : "Conversation updated.");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update conversation.", "error");
    }
  }

  function openCompose() {
    setComposer({
      ...newComposer(),
      text: activeMailbox?.signature ? `\n\n${activeMailbox.signature}` : "",
    });
  }

  async function openDraft(item: MailConversationSummary) {
    if (!item.draftId) return;
    setConversationLoading(true);
    try {
      const draft = await api<MailDraft>(`/mail/drafts/${encodeURIComponent(item.draftId)}`);
      setComposer({
        mode: "draft",
        draftId: item.draftId,
        conversationId: item.id,
        to: draft.to.join(", "),
        cc: draft.cc.join(", "),
        bcc: draft.bcc.join(", "),
        subject: draft.subject,
        text: draft.text,
        idempotencyKey: crypto.randomUUID(),
        deliveryUncertain: draft.status === "uncertain",
        attachments: draft.attachments ?? [],
      });
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to open draft.", "error");
    } finally {
      setConversationLoading(false);
    }
  }

  function openReply() {
    if (!conversation) return;
    const inbound = [...conversation.messages]
      .reverse()
      .find((message) => message.direction === "inbound");
    if (!inbound) return;
    setComposer({
      ...newComposer(),
      mode: "reply",
      conversationId: conversation.id,
      to: inbound.replyTo[0]?.email ?? inbound.from.email,
      text: activeMailbox?.signature ? `\n\n${activeMailbox.signature}` : "",
      subject: conversation.subject.toLowerCase().startsWith("re:")
        ? conversation.subject
        : `Re: ${conversation.subject}`,
    });
  }

  function openForward(message: MailMessage) {
    const addressLabel = (address: MailMessage["from"]) =>
      address.name ? `${address.name} <${address.email}>` : address.email;
    const headers = [
      "---------- Forwarded message ----------",
      `From: ${addressLabel(message.from)}`,
      `Date: ${new Date(message.receivedAt ?? message.sentAt ?? message.createdAt).toLocaleString()}`,
      `Subject: ${message.subject}`,
      `To: ${message.to.map(addressLabel).join(", ")}`,
      ...(message.cc.length ? [`Cc: ${message.cc.map(addressLabel).join(", ")}`] : []),
    ];
    setComposer({
      ...newComposer(),
      mode: "forward",
      forwardMessageId: message.id,
      subject: /^(?:fwd|fw):/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
      text: `\n\n${activeMailbox?.signature ? `${activeMailbox.signature}\n\n` : ""}${headers.join("\n")}\n\n${message.text}`,
    });
  }

  function draftInput(): MailDraftInput {
    if (!composer) throw new Error("Composer is closed.");
    return {
      mailboxId,
      forwardMessageId: composer.draftId ? undefined : composer.forwardMessageId,
      conversationId: composer.conversationId,
      to: addresses(composer.to),
      cc: addresses(composer.cc),
      bcc: addresses(composer.bcc),
      subject: composer.subject.trim(),
      text: composer.text,
    };
  }

  async function persistDraft() {
    if (!composer) return null;
    const input = draftInput();
    const draft = await api<MailDraft>(
      composer.draftId ? `/mail/drafts/${composer.draftId}` : "/mail/drafts",
      {
        method: composer.draftId ? "PATCH" : "POST",
        body: JSON.stringify(input),
      },
    );
    setComposer((current) =>
      current
        ? {
            ...current,
            draftId: draft.id,
            conversationId: draft.conversationId,
            attachments: draft.attachments ?? current.attachments,
          }
        : current,
    );
    return draft;
  }

  async function saveDraft(event?: FormEvent) {
    event?.preventDefault();
    if (composer?.deliveryUncertain) return;
    setSaving(true);
    try {
      await persistDraft();
      notify("Draft saved.");
      setComposer(null);
      setFolder("drafts");
      reloadList();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save draft.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function sendDraft() {
    if (!composer || !addresses(composer.to).length || !composer.subject.trim()) return;
    setSending(true);
    try {
      const draft = await persistDraft();
      if (!draft) return;
      const result = await api<MailSendResult>(`/mail/drafts/${draft.id}/send`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: composer.idempotencyKey }),
      });
      if (result.draft.status === "failed" || result.draft.status === "uncertain") {
        setComposer((current) =>
          current
            ? { ...current, draftId: draft.id, conversationId: draft.conversationId }
            : current,
        );
        notify(
          result.draft.status === "failed"
            ? "Delivery failed. Your draft is still open so you can review it and try again."
            : "Delivery could not be confirmed. Check Sent before trying again.",
          "error",
        );
        reloadList();
        await reloadSetup();
        return;
      }

      const rejected = [
        result.permanentBounces.length
          ? `${result.permanentBounces.length} ${result.permanentBounces.length === 1 ? "address bounced" : "addresses bounced"}`
          : "",
        result.suppressed.length
          ? `${result.suppressed.length} ${result.suppressed.length === 1 ? "address was suppressed" : "addresses were suppressed"}`
          : "",
      ].filter(Boolean);
      if (rejected.length) {
        const accepted = result.delivered.length + result.queued.length;
        notify(
          `${accepted ? `${accepted} ${accepted === 1 ? "recipient was accepted" : "recipients were accepted"}; ` : ""}${rejected.join("; ")}.`,
          "error",
        );
      } else if (result.draft.status === "sent") {
        notify("Message sent.");
      } else if (
        result.draft.status === "queued" ||
        (result.queued.length && !result.delivered.length)
      ) {
        notify("Message queued for delivery.");
      } else if (result.queued.length) {
        notify(
          `${result.delivered.length} delivered; ${result.queued.length} queued for delivery.`,
        );
      } else {
        notify("Message sent.");
      }
      setComposer(null);
      setFolder("sent");
      reloadList();
      await reloadSetup();
    } catch (caught) {
      notify(
        caught instanceof ApiError && caught.status === 502
          ? `${caught.message} Check Sent before trying again.`
          : caught instanceof Error
            ? `${caught.message} Your draft remains open.`
            : "Unable to send. Your draft remains open.",
        "error",
      );
    } finally {
      setSending(false);
    }
  }

  async function uploadAttachment(file: File) {
    if (!composer || composer.deliveryUncertain) return;
    if (file.size > 2 * 1024 * 1024) {
      notify("Attachments must be 2 MB or smaller.", "error");
      return;
    }
    setUploading(true);
    try {
      const draft = await persistDraft();
      if (!draft) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const attachment = await api<MailAttachment>(`/mail/drafts/${draft.id}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          contentBase64: btoa(binary),
        }),
      });
      setComposer((current) =>
        current
          ? {
              ...current,
              draftId: draft.id,
              conversationId: draft.conversationId,
              attachments: [...current.attachments, attachment],
            }
          : current,
      );
      notify("Attachment added.");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to add attachment.", "error");
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment(attachment: MailAttachment) {
    if (!composer?.draftId || composer.deliveryUncertain) return;
    setUploading(true);
    try {
      await api(`/mail/drafts/${composer.draftId}/attachments/${attachment.id}`, {
        method: "DELETE",
      });
      setComposer((current) =>
        current
          ? {
              ...current,
              attachments: current.attachments.filter((item) => item.id !== attachment.id),
            }
          : current,
      );
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to remove attachment.", "error");
    } finally {
      setUploading(false);
    }
  }

  async function deleteDraft() {
    if (!composer?.draftId) return setComposer(null);
    setSaving(true);
    try {
      await api(`/mail/drafts/${composer.draftId}`, { method: "DELETE" });
      setComposer(null);
      notify("Draft deleted.");
      reloadList();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to delete draft.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function markDraftFailed(item: MailConversation) {
    if (
      !item.draftId ||
      !window.confirm(
        "Mark this message as failed? Orbit cannot confirm whether it was delivered, so check Sent before trying again.",
      )
    )
      return;
    setSaving(true);
    try {
      await api(`/mail/drafts/${item.draftId}/mark-failed`, { method: "POST" });
      const { conversation: next } = await api<{ conversation: MailConversation }>(
        `/mail/conversations/${encodeURIComponent(item.id)}?mailboxId=${encodeURIComponent(mailboxId)}`,
      );
      setConversation(next);
      notify("Marked as failed. You can now edit, retry, or delete the draft.");
      reloadList();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to mark as failed.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function provisionMailbox(event: FormEvent) {
    event.preventDefault();
    setProvisioning(true);
    try {
      const mailbox = await api<{ id: string }>("/mail/mailboxes", {
        method: "POST",
        body: JSON.stringify({
          email: `${mailboxForm.localPart.trim()}@${mailboxForm.domain || setup?.configuredDomains[0] || ""}`,
          displayName: mailboxForm.displayName.trim(),
          kind: mailboxForm.kind,
          ownerId: mailboxForm.kind === "private" ? mailboxForm.ownerId || user?.id : null,
        }),
      });
      await reloadSetup();
      setMailboxId(mailbox.id);
      setSetupOpen(false);
      notify("Mailbox created.");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create mailbox.", "error");
    } finally {
      setProvisioning(false);
    }
  }

  async function saveMailboxSettings(event: FormEvent) {
    event.preventDefault();
    if (!activeMailbox || !canEditActiveMailbox) return;
    setSavingMailbox(true);
    try {
      await api(`/mail/mailboxes/${activeMailbox.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: mailboxSettings.displayName.trim(),
          signature: mailboxSettings.signature,
          replyTo: mailboxSettings.replyTo.trim() || null,
          ...(canManage ? { enabled: mailboxSettings.enabled } : {}),
        }),
      });
      await reloadSetup();
      notify("Mailbox settings saved.");
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Unable to save mailbox settings.",
        "error",
      );
    } finally {
      setSavingMailbox(false);
    }
  }

  const composerDirty = Boolean(
    composer &&
    (composer.draftId ||
      composer.to.trim() ||
      composer.cc.trim() ||
      composer.bcc.trim() ||
      composer.subject.trim() ||
      composer.text.trim()),
  );

  function closeComposer() {
    if (sending || uploading) return;
    if (
      composerDirty &&
      !window.confirm("Discard the changes in this message? Save it as a draft to keep your work.")
    ) {
      return;
    }
    setComposer(null);
  }

  return (
    <AppShell
      title="Inbox"
      contentWidth="full"
      actions={
        <>
          {canEditActiveMailbox ? (
            <Button
              size="icon"
              variant="plain"
              aria-label="Mailbox settings"
              onClick={() => setSetupOpen(true)}
            >
              <GearIcon size={16} />
            </Button>
          ) : null}
          <Button variant="primary" onClick={openCompose} disabled={!activeMailbox?.enabled}>
            <PlusIcon size={15} /> Compose
          </Button>
        </>
      }
    >
      {setupLoading ? (
        <div className="inbox-loading">
          <Spinner />
        </div>
      ) : setupError ? (
        <EmptyState
          icon={<MailIcon size={20} />}
          title="Inbox is unavailable"
          description={setupError}
          action={<Button onClick={() => void reloadSetup()}>Try again</Button>}
        />
      ) : !setup?.mailboxes.length ? (
        <EmptyState
          icon={<MailIcon size={20} />}
          title="Set up your first mailbox"
          description={
            setup?.canProvision
              ? "Create a mailbox on a configured company domain to start receiving mail."
              : "Ask a workspace administrator to configure a company email domain and create a mailbox for you."
          }
          action={
            setup?.canProvision ? (
              <Button variant="primary" onClick={() => setSetupOpen(true)}>
                Create mailbox
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="inbox-layout">
          <aside className={cx("inbox-rail", selectedId && "is-hidden-mobile")}>
            <div className="inbox-mailbox">
              {setup.mailboxes.length > 1 ? (
                <Select
                  aria-label="Mailbox"
                  value={mailboxId}
                  onValueChange={setMailboxId}
                  renderValue={() => activeMailbox?.displayName}
                  renderOption={(option) => {
                    const mailbox = setup.mailboxes.find((item) => item.id === option.value)!;
                    return (
                      <span className="inbox-mailbox-option">
                        <strong>{mailbox.displayName}</strong>
                        <span>{mailbox.email}</span>
                      </span>
                    );
                  }}
                >
                  {setup.mailboxes.map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.id}>
                      {mailbox.displayName} · {mailbox.email}
                    </option>
                  ))}
                </Select>
              ) : (
                <strong className="inbox-mailbox-name">{activeMailbox?.displayName}</strong>
              )}
              <span className="inbox-mailbox-address">{activeMailbox?.email}</span>
            </div>
            {!setup.providerReady ? (
              <button
                className="inbox-setup-callout"
                type="button"
                onClick={() => canManage && setSetupOpen(true)}
              >
                <strong>Email transport isn’t configured</strong>
                <span>
                  {canManage
                    ? "Open setup to see the required domain configuration."
                    : "An administrator needs to finish Cloudflare email setup."}
                </span>
              </button>
            ) : null}
            <nav className="inbox-folders" aria-label="Mail folders">
              {FOLDERS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={cx(folder === value && "is-active")}
                  onClick={() => setFolder(value)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                  {value === "inbox" && activeMailbox?.unreadCount ? (
                    <span className="inbox-count">{activeMailbox.unreadCount}</span>
                  ) : null}
                </button>
              ))}
            </nav>
          </aside>

          <section
            className={cx("inbox-list-pane", selectedId && "is-hidden-mobile")}
            aria-label={`${folder} conversations`}
          >
            <div className="inbox-list-tools">
              <SearchInput value={search} onChange={setSearch} placeholder="Search mail…" />
              <Button
                size="small"
                variant={unreadOnly ? "secondary" : "plain"}
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly((value) => !value)}
              >
                <UnreadSquareBadgeIcon size={15} /> Unread
              </Button>
              <Button
                size="small"
                variant={starredOnly ? "secondary" : "plain"}
                aria-pressed={starredOnly}
                onClick={() => setStarredOnly((value) => !value)}
              >
                <StarOutlineIcon size={15} /> Starred
              </Button>
            </div>
            {listLoading ? (
              <div className="inbox-loading">
                <Spinner />
              </div>
            ) : listError ? (
              <EmptyState
                title="Couldn’t load mail"
                description={listError}
                action={<Button onClick={reloadList}>Try again</Button>}
              />
            ) : list?.conversations.length ? (
              <div className="inbox-conversations">
                {list.conversations.map((item) => {
                  const status = deliveryLabel(item.deliveryStatus);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cx(
                        "inbox-conversation",
                        item.unread && "is-unread",
                        selectedId === item.id && "is-selected",
                      )}
                      onClick={() =>
                        folder === "drafts" && item.draftId
                          ? void openDraft(item)
                          : setSelectedId(item.id)
                      }
                    >
                      <span className="inbox-conversation-top">
                        <strong>{sender(item)}</strong>
                        <time>{formatDate(item.lastMessageAt, true)}</time>
                      </span>
                      <span className="inbox-conversation-subject">
                        {item.subject || "(No subject)"}
                        {item.messageCount > 1 ? <small>{item.messageCount}</small> : null}
                      </span>
                      <span className="inbox-conversation-preview">
                        {item.preview || "No message preview"}
                      </span>
                      <span className="inbox-conversation-flags">
                        {item.draft ? <Badge tone="amber">Draft</Badge> : null}
                        {status ? (
                          <Badge
                            tone={
                              item.deliveryStatus === "failed" ||
                              item.deliveryStatus === "uncertain"
                                ? "red"
                                : "neutral"
                            }
                          >
                            {status}
                          </Badge>
                        ) : null}
                        {item.starred ? <StarFilledIcon size={14} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={<InboxIcon size={20} />}
                title={`No ${folder} mail`}
                description={
                  search || unreadOnly || starredOnly
                    ? "No conversations match the current search and filters."
                    : folder === "inbox"
                      ? "New messages will appear here when this mailbox receives them."
                      : `This mailbox has no conversations in ${folder}.`
                }
              />
            )}
            {!listLoading && !listError && list?.pagination.total ? (
              <nav className="inbox-pagination" aria-label="Conversation pages">
                <span>
                  {(list.pagination.page - 1) * list.pagination.pageSize + 1}–
                  {Math.min(list.pagination.page * list.pagination.pageSize, list.pagination.total)}{" "}
                  of {list.pagination.total}
                </span>
                <div>
                  <Button
                    type="button"
                    variant="plain"
                    size="icon"
                    aria-label="Previous page"
                    disabled={listLoading || list.pagination.page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    <ChevronLeftIcon size={16} />
                  </Button>
                  <span>
                    {list.pagination.page} / {list.pagination.pages}
                  </span>
                  <Button
                    type="button"
                    variant="plain"
                    size="icon"
                    aria-label="Next page"
                    disabled={listLoading || list.pagination.page >= list.pagination.pages}
                    onClick={() =>
                      setPage((current) => Math.min(list.pagination.pages, current + 1))
                    }
                  >
                    <ChevronRightIcon size={16} />
                  </Button>
                </div>
              </nav>
            ) : null}
          </section>

          <section
            className={cx("inbox-reader", selectedId && "is-open-mobile")}
            aria-label="Conversation"
          >
            {conversationLoading ? (
              <div className="inbox-loading">
                <Spinner />
              </div>
            ) : conversation && selectedSummary ? (
              <>
                <header className="inbox-reader-header">
                  <Button
                    className="inbox-back"
                    variant="plain"
                    size="icon"
                    aria-label="Back to conversations"
                    onClick={() => setSelectedId(null)}
                  >
                    <ArrowLeftIcon size={17} />
                  </Button>
                  <div>
                    <h2>{conversation.subject || "(No subject)"}</h2>
                    <span>
                      {conversation.messageCount}{" "}
                      {conversation.messageCount === 1 ? "message" : "messages"}
                    </span>
                  </div>
                  <div className="inbox-reader-actions">
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label={conversation.starred ? "Remove star" : "Star conversation"}
                      onClick={() =>
                        void updateState(conversation, { starred: !conversation.starred })
                      }
                    >
                      {conversation.starred ? (
                        <StarFilledIcon size={17} />
                      ) : (
                        <StarOutlineIcon size={17} />
                      )}
                    </Button>
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label={
                        conversation.archived ? "Restore conversation" : "Archive conversation"
                      }
                      onClick={() =>
                        void updateState(conversation, { archived: !conversation.archived })
                      }
                    >
                      <ArchiveIcon size={17} />
                    </Button>
                  </div>
                </header>
                <div className="inbox-thread">
                  {conversation.messages.map((message) => (
                    <article className="inbox-message" key={message.id}>
                      <header>
                        <div>
                          <strong>{message.from.name || message.from.email}</strong>
                          {message.from.name ? <span>{message.from.email}</span> : null}
                          <span>
                            to{" "}
                            {message.to.map((address) => address.name || address.email).join(", ")}
                          </span>
                        </div>
                        <time>
                          {formatDate(
                            message.receivedAt ?? message.sentAt ?? message.createdAt,
                            true,
                          )}
                        </time>
                      </header>
                      {message.status === "failed" || message.status === "uncertain" ? (
                        <div className="inbox-delivery-warning">
                          <strong>
                            {message.status === "failed"
                              ? "Delivery failed"
                              : "Delivery could not be confirmed"}
                          </strong>
                          {message.error ? <span>{message.error}</span> : null}
                        </div>
                      ) : null}
                      <pre>{message.text}</pre>
                      {message.attachments.length ? (
                        <div className="inbox-attachments" aria-label="Attachments">
                          {message.attachments.map((attachment) => (
                            <a key={attachment.id} href={attachment.downloadUrl} download>
                              <PaperclipIcon size={14} />
                              <span>{attachment.filename}</span>
                              <small>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</small>
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {["received", "sent", "queued"].includes(message.status) ? (
                        <Button
                          variant="plain"
                          onClick={() => openForward(message)}
                          disabled={!activeMailbox?.enabled}
                        >
                          <ArrowRightIcon size={15} /> Forward
                        </Button>
                      ) : null}
                    </article>
                  ))}
                </div>
                <footer className="inbox-reader-footer">
                  {conversation.draftId &&
                  ["draft", "failed"].includes(conversation.deliveryStatus ?? "") ? (
                    <Button variant="primary" onClick={() => void openDraft(conversation)}>
                      <PencilIcon size={15} /> Edit draft
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={openReply}
                      disabled={!activeMailbox?.enabled}
                    >
                      <ReplyIcon size={15} /> Reply
                    </Button>
                  )}
                  {latestForwardableMessage ? (
                    <Button
                      onClick={() => openForward(latestForwardableMessage)}
                      disabled={!activeMailbox?.enabled}
                    >
                      <ArrowRightIcon size={15} /> Forward
                    </Button>
                  ) : null}
                  {conversation.canMarkFailed ? (
                    <Button disabled={saving} onClick={() => void markDraftFailed(conversation)}>
                      Mark as failed
                    </Button>
                  ) : null}
                </footer>
              </>
            ) : (
              <EmptyState
                icon={<MailIcon size={20} />}
                title="Select a conversation"
                description="Choose a conversation to read its messages and reply."
              />
            )}
          </section>
        </div>
      )}

      <Modal
        open={Boolean(composer)}
        onClose={closeComposer}
        title={composerTitles[composer?.mode ?? "new"]}
        description={
          activeMailbox ? `From ${activeMailbox.displayName} <${activeMailbox.email}>` : undefined
        }
        footer={
          <>
            <div className="inbox-compose-delete">
              {composer?.draftId && !composer.deliveryUncertain ? (
                <Button
                  variant="plain"
                  size="icon"
                  aria-label="Delete draft"
                  disabled={saving || sending || uploading}
                  onClick={() => void deleteDraft()}
                >
                  <StaticTrashIcon size={16} />
                </Button>
              ) : null}
            </div>
            <Button
              disabled={saving || sending || uploading || composer?.deliveryUncertain}
              onClick={() => void saveDraft()}
            >
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <Button
              variant="primary"
              disabled={
                saving ||
                sending ||
                uploading ||
                !setup?.providerReady ||
                composer?.deliveryUncertain ||
                !composer?.to.trim() ||
                !composer?.subject.trim()
              }
              onClick={() => void sendDraft()}
            >
              {sending ? (
                <>
                  <Spinner /> Sending…
                </>
              ) : (
                <>
                  <PaperAirplaneIcon size={15} /> Send
                </>
              )}
            </Button>
          </>
        }
      >
        {composer ? (
          <form className="inbox-compose-form" onSubmit={saveDraft}>
            {composer.forwardMessageId && !composer.draftId ? (
              <p>Original attachments will be included when you save or send this draft.</p>
            ) : null}
            {composer.deliveryUncertain ? (
              <div className="inbox-delivery-warning">
                <strong>Delivery could not be confirmed</strong>
                <span>
                  Check Sent before creating another message to avoid sending a duplicate.
                </span>
              </div>
            ) : null}
            <Field label="To">
              <Input
                autoFocus
                required
                disabled={composer.deliveryUncertain}
                type="text"
                inputMode="email"
                placeholder="name@company.com"
                value={composer.to}
                onChange={(event) => setComposer({ ...composer, to: event.target.value })}
              />
            </Field>
            <div className="inbox-compose-copies">
              <Field label="Cc">
                <Input
                  type="text"
                  disabled={composer.deliveryUncertain}
                  inputMode="email"
                  value={composer.cc}
                  onChange={(event) => setComposer({ ...composer, cc: event.target.value })}
                />
              </Field>
              <Field label="Bcc">
                <Input
                  type="text"
                  disabled={composer.deliveryUncertain}
                  inputMode="email"
                  value={composer.bcc}
                  onChange={(event) => setComposer({ ...composer, bcc: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Subject">
              <Input
                required
                disabled={composer.deliveryUncertain}
                value={composer.subject}
                onChange={(event) => setComposer({ ...composer, subject: event.target.value })}
              />
            </Field>
            <Field
              label="Message"
              hint="Plain text only. Remote images and tracking content are not loaded."
            >
              <Textarea
                rows={12}
                disabled={composer.deliveryUncertain}
                value={composer.text}
                onChange={(event) => setComposer({ ...composer, text: event.target.value })}
              />
            </Field>
            <div className="inbox-compose-attachments">
              {composer.attachments.length ? (
                <div className="inbox-attachment-list" aria-label="Draft attachments">
                  {composer.attachments.map((attachment) => (
                    <div key={attachment.id}>
                      <a href={attachment.downloadUrl} download>
                        <PaperclipIcon size={14} />
                        <span>{attachment.filename}</span>
                        <small>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</small>
                      </a>
                      {!composer.deliveryUncertain ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="plain"
                          aria-label={`Remove ${attachment.filename}`}
                          disabled={uploading}
                          onClick={() => void removeAttachment(attachment)}
                        >
                          <CloseIcon size={14} />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {!composer.deliveryUncertain ? (
                <label className={cx("inbox-attach-button", uploading && "is-disabled")}>
                  {uploading ? <Spinner /> : <PaperclipIcon size={15} />}
                  <span>{uploading ? "Adding…" : "Attach file"}</span>
                  <input
                    type="file"
                    disabled={uploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadAttachment(file);
                    }}
                  />
                </label>
              ) : null}
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title="Mailbox setup"
        description="Cloudflare email domains and mailbox access for this workspace."
      >
        <div className="inbox-setup-panel">
          <div className="inbox-setup-status">
            <span className={cx("inbox-status-dot", setup?.providerReady && "is-ready")} />
            <div>
              <strong>
                {setup?.providerReady
                  ? "Outbound sending is ready"
                  : "Email transport needs configuration"}
              </strong>
              <span>
                {setup?.providerReady
                  ? "Cloudflare outbound delivery is configured. Receiving requires separate DNS and routing verification."
                  : "Configure the Cloudflare email binding and credentials on the server before sending."}
              </span>
            </div>
          </div>
          {activeMailbox && canEditActiveMailbox ? (
            <form className="form-grid inbox-mailbox-settings" onSubmit={saveMailboxSettings}>
              <div className="inbox-settings-heading">
                <div>
                  <strong>{activeMailbox.email}</strong>
                  <span>
                    {activeMailbox.kind === "shared" ? "Shared mailbox" : "Private mailbox"}
                  </span>
                </div>
                <Badge tone={activeMailbox.enabled ? "green" : "neutral"}>
                  {activeMailbox.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <Field label="Display name">
                <Input
                  required
                  value={mailboxSettings.displayName}
                  onChange={(event) =>
                    setMailboxSettings({ ...mailboxSettings, displayName: event.target.value })
                  }
                />
              </Field>
              <Field label="Reply-to address" hint="Optional. Replies will be directed here.">
                <Input
                  type="email"
                  placeholder={activeMailbox.email}
                  value={mailboxSettings.replyTo}
                  onChange={(event) =>
                    setMailboxSettings({ ...mailboxSettings, replyTo: event.target.value })
                  }
                />
              </Field>
              <Field label="Signature" hint="Added to new messages and replies.">
                <Textarea
                  rows={4}
                  value={mailboxSettings.signature}
                  onChange={(event) =>
                    setMailboxSettings({ ...mailboxSettings, signature: event.target.value })
                  }
                />
              </Field>
              {canManage ? (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={mailboxSettings.enabled}
                    onChange={(event) =>
                      setMailboxSettings({ ...mailboxSettings, enabled: event.target.checked })
                    }
                  />
                  Mailbox enabled
                </label>
              ) : null}
              <Button type="submit" disabled={savingMailbox}>
                {savingMailbox ? "Saving…" : "Save mailbox settings"}
              </Button>
            </form>
          ) : null}
          <div>
            <strong>Configured domains</strong>
            <div className="inbox-domain-list">
              {setup?.configuredDomains.length ? (
                setup.configuredDomains.map((domain) => <Badge key={domain}>{domain}</Badge>)
              ) : (
                <span>No domains configured</span>
              )}
            </div>
          </div>
          {setup?.canProvision && setup.configuredDomains.length ? (
            <form className="form-grid inbox-mailbox-form" onSubmit={provisionMailbox}>
              <Field label="Display name">
                <Input
                  required
                  value={mailboxForm.displayName}
                  onChange={(event) =>
                    setMailboxForm({ ...mailboxForm, displayName: event.target.value })
                  }
                />
              </Field>
              <Field label="Address">
                <div className="inbox-address-field">
                  <Input
                    required
                    pattern="[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+"
                    placeholder="hello"
                    value={mailboxForm.localPart}
                    onChange={(event) =>
                      setMailboxForm({ ...mailboxForm, localPart: event.target.value })
                    }
                  />
                  <Select
                    aria-label="Domain"
                    value={mailboxForm.domain || setup.configuredDomains[0]}
                    onValueChange={(domain) => setMailboxForm({ ...mailboxForm, domain })}
                  >
                    {setup.configuredDomains.map((domain) => (
                      <option key={domain} value={domain}>
                        @{domain}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
              <Field label="Access">
                <Select
                  value={mailboxForm.kind}
                  onValueChange={(kind) =>
                    setMailboxForm({ ...mailboxForm, kind: kind as "private" | "shared" })
                  }
                >
                  <option value="shared">Shared with workspace</option>
                  <option value="private">Private to me</option>
                </Select>
              </Field>
              <Button type="submit" variant="primary" disabled={provisioning}>
                {provisioning ? "Creating…" : "Create mailbox"}
              </Button>
            </form>
          ) : null}
        </div>
      </Modal>
    </AppShell>
  );
}
