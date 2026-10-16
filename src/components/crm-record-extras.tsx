import { CheckIcon as Check, CloseIcon as Close, PlusIcon as Plus, TagIcon as Tag } from "./icons";
import { useEffect, useMemo, useState } from "react";

import { api, titleCase } from "../lib/api";
import { useData } from "../lib/use-data";
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Textarea, useToast } from "./ui";

type EntityType = "account" | "contact" | "opportunity";
type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  fieldType: string;
  description: string | null;
  required: boolean;
  options: string[];
};
type FieldValue = { fieldDefinitionId: string; value: unknown };
type TagRecord = { id: string; name: string; color: string };
type Evidence = {
  id: string;
  field_key: string;
  proposed_value: unknown;
  source_url: string | null;
  excerpt: string | null;
  status: "pending" | "accepted" | "dismissed";
};
type SyncedContext = {
  threads: Array<{
    id: string;
    subject: string | null;
    snippet: string | null;
    latestMessageAt: string | null;
    provider: string;
    messageCount: number;
  }>;
  events: Array<{
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    meetingUrl: string | null;
    provider: string;
  }>;
};

function fieldControl(field: FieldDefinition, value: unknown, onChange: (value: unknown) => void) {
  if (field.fieldType === "long_text") {
    return (
      <Textarea value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
    );
  }
  if (field.fieldType === "checkbox") {
    return (
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {value ? "Yes" : "No"}
      </label>
    );
  }
  if (field.fieldType === "select") {
    return (
      <Select value={String(value ?? "")} onValueChange={onChange}>
        <option value="">Not set</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      type={
        field.fieldType === "number"
          ? "number"
          : field.fieldType === "date"
            ? "date"
            : field.fieldType === "email"
              ? "email"
              : field.fieldType === "url"
                ? "url"
                : field.fieldType === "phone"
                  ? "tel"
                  : "text"
      }
      value={String(value ?? "")}
      onChange={(event) =>
        onChange(
          field.fieldType === "number" && event.target.value
            ? Number(event.target.value)
            : event.target.value,
        )
      }
    />
  );
}

export function CrmRecordExtras({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: string;
}) {
  const { notify } = useToast();
  const { data: definitions } = useData<{ fields: FieldDefinition[] }>(
    `/crm/fields?entityType=${entityType}`,
  );
  const { data: valuesData, reload: reloadValues } = useData<{ values: FieldValue[] }>(
    `/crm/field-values/${entityType}/${entityId}`,
  );
  const { data: allTags } = useData<{ tags: TagRecord[] }>("/crm/tags");
  const { data: assignedTags, reload: reloadTags } = useData<{ tags: TagRecord[] }>(
    `/crm/entities/${entityType}/${entityId}/tags`,
  );
  const { data: evidenceData, reload: reloadEvidence } = useData<{ evidence: Evidence[] }>(
    `/crm/evidence/${entityType}/${entityId}`,
  );
  const { data: synced } = useData<SyncedContext>(`/crm/sync/${entityType}/${entityId}`);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [tagId, setTagId] = useState("");
  const [savingField, setSavingField] = useState<string | null>(null);

  useEffect(() => {
    setValues(
      Object.fromEntries(
        (valuesData?.values ?? []).map((item) => [item.fieldDefinitionId, item.value]),
      ),
    );
  }, [valuesData]);

  const availableTags = useMemo(() => {
    const assigned = new Set((assignedTags?.tags ?? []).map((tag) => tag.id));
    return (allTags?.tags ?? []).filter((tag) => !assigned.has(tag.id));
  }, [allTags, assignedTags]);

  async function saveField(field: FieldDefinition) {
    setSavingField(field.id);
    try {
      await api("/crm/field-values", {
        method: "PUT",
        body: JSON.stringify({
          fieldDefinitionId: field.id,
          entityType,
          entityId,
          value: values[field.id] ?? "",
        }),
      });
      notify(`${field.label} updated.`);
      await reloadValues();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save custom field.", "error");
    } finally {
      setSavingField(null);
    }
  }

  async function updateTags(tagIds: string[]) {
    try {
      await api(`/crm/entities/${entityType}/${entityId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tagIds }),
      });
      setTagId("");
      await reloadTags();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to update tags.", "error");
    }
  }

  async function reviewEvidence(id: string, status: "accepted" | "dismissed") {
    try {
      await api(`/crm/evidence/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      notify(status === "accepted" ? "Evidence accepted." : "Evidence dismissed.");
      await reloadEvidence();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to review evidence.", "error");
    }
  }

  const assignedIds = (assignedTags?.tags ?? []).map((tag) => tag.id);
  const pendingEvidence = (evidenceData?.evidence ?? []).filter(
    (item) => item.status === "pending",
  );

  if (
    !definitions?.fields.length &&
    !allTags?.tags.length &&
    !pendingEvidence.length &&
    !synced?.threads.length &&
    !synced?.events.length
  )
    return null;

  return (
    <Panel>
      <div className="section-heading">
        <div>
          <h2>Workspace context</h2>
          <p>Custom fields, tags, and evidence reviewed by your team.</p>
        </div>
      </div>
      {assignedTags?.tags.length || availableTags.length ? (
        <div className="stack-compact">
          <span className="field-label">Tags</span>
          <div className="inline-cluster">
            {assignedTags?.tags.map((tag) => (
              <Button
                key={tag.id}
                size="small"
                onClick={() => void updateTags(assignedIds.filter((id) => id !== tag.id))}
              >
                <Tag size={12} /> {tag.name} <Close size={11} />
              </Button>
            ))}
            {availableTags.length ? (
              <Select
                value={tagId}
                onValueChange={(value) => {
                  setTagId(value);
                  if (value) void updateTags([...assignedIds, value]);
                }}
              >
                <option value="">Add tag…</option>
                {availableTags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        </div>
      ) : null}
      {definitions?.fields.length ? (
        <div className="form-grid crm-custom-fields">
          {definitions.fields.map((field) => (
            <Field key={field.id} label={field.label} hint={field.description ?? undefined}>
              <div className="inline-field-control">
                {fieldControl(field, values[field.id], (value) =>
                  setValues((current) => ({ ...current, [field.id]: value })),
                )}
                <Button
                  size="small"
                  disabled={savingField === field.id}
                  onClick={() => void saveField(field)}
                >
                  <Check size={13} /> Save
                </Button>
              </div>
            </Field>
          ))}
        </div>
      ) : null}
      {pendingEvidence.length ? (
        <div className="stack-list">
          <span className="field-label">Evidence proposals</span>
          {pendingEvidence.map((item) => (
            <div className="list-row" key={item.id}>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{titleCase(item.field_key)}</span>
                  <Badge tone="amber">Review</Badge>
                </div>
                <div className="list-row-meta">
                  <span>
                    {typeof item.proposed_value === "string"
                      ? item.proposed_value
                      : JSON.stringify(item.proposed_value)}
                  </span>
                  <span>{item.excerpt || "No excerpt"}</span>
                  {item.source_url ? (
                    <a href={item.source_url} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  ) : null}
                </div>
              </div>
              <div className="inline-cluster">
                <Button size="small" onClick={() => void reviewEvidence(item.id, "dismissed")}>
                  Dismiss
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => void reviewEvidence(item.id, "accepted")}
                >
                  <Plus size={12} /> Accept
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {synced?.threads.length || synced?.events.length ? (
        <div className="stack-list">
          <span className="field-label">Read-only communication context</span>
          {synced.events.map((event) => (
            <div className="list-row" key={event.id}>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{event.title}</span>
                  <Badge>{titleCase(event.provider)} calendar</Badge>
                </div>
                <div className="list-row-meta">
                  <span>{new Date(event.startsAt).toLocaleString()}</span>
                  {event.meetingUrl ? (
                    <a href={event.meetingUrl} target="_blank" rel="noreferrer">
                      Meeting link
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {synced.threads.map((thread) => (
            <div className="list-row" key={thread.id}>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{thread.subject || "Email thread"}</span>
                  <Badge>{thread.messageCount} messages</Badge>
                </div>
                <div className="list-row-meta">
                  <span>{thread.snippet || "No preview"}</span>
                  <span>
                    {thread.latestMessageAt
                      ? new Date(thread.latestMessageAt).toLocaleString()
                      : titleCase(thread.provider)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {!definitions?.fields.length &&
      !assignedTags?.tags.length &&
      !pendingEvidence.length &&
      !synced?.threads.length &&
      !synced?.events.length ? (
        <EmptyState
          title="No workspace context"
          description="Fields, tags, evidence, and synced activity for this record will appear here."
        />
      ) : null}
    </Panel>
  );
}
