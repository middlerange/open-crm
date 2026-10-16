import { CheckIcon as Check } from "./icons";
import { useState, type FormEvent } from "react";

import { api } from "../lib/api";
import { Button, Field, Modal, Textarea, useToast } from "./ui";

const emptyUpdate = { moved: "", stuck: "", learned: "", tomorrow: "" };

export function DailyCloseoutAction() {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [update, setUpdate] = useState(emptyUpdate);
  const [saving, setSaving] = useState(false);

  async function saveUpdate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/updates/today", { method: "PUT", body: JSON.stringify(update) });
      notify("Daily closeout saved.");
      setOpen(false);
      setUpdate(emptyUpdate);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to save update.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Check size={15} /> Daily closeout
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Daily closeout"
        description="A short learning loop for tomorrow’s work."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button form="daily-closeout" variant="primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save closeout"}
            </Button>
          </>
        }
      >
        <form id="daily-closeout" onSubmit={saveUpdate} className="form-grid">
          <Field label="What moved?">
            <Textarea
              required
              value={update.moved}
              onChange={(event) => setUpdate({ ...update, moved: event.target.value })}
              placeholder="Accounts approved, conversations started, assets completed…"
            />
          </Field>
          <Field label="What got stuck?">
            <Textarea
              value={update.stuck}
              onChange={(event) => setUpdate({ ...update, stuck: event.target.value })}
              placeholder="Missing evidence, unclear message, dependency…"
            />
          </Field>
          <Field label="What did you learn?">
            <Textarea
              value={update.learned}
              onChange={(event) => setUpdate({ ...update, learned: event.target.value })}
              placeholder="A signal, objection, buyer pattern, or process lesson…"
            />
          </Field>
          <Field label="What changes tomorrow?">
            <Textarea
              required
              value={update.tomorrow}
              onChange={(event) => setUpdate({ ...update, tomorrow: event.target.value })}
              placeholder="The specific next adjustment…"
            />
          </Field>
        </form>
      </Modal>
    </>
  );
}
