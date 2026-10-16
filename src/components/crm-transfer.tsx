import { useState } from "react";
import { api, titleCase } from "../lib/api";
import {
  downloadBlob,
  downloadExport,
  importFields,
  initialMapping,
  mappedCsv,
  readTransferFile,
  type ExportType,
  type ImportType,
  type TransferTable,
} from "../lib/crm-transfer";
import { Badge, Button, Field, Input, Modal, Select, useToast } from "./ui";

type ImportPreview = {
  rowCount: number;
  headers: string[];
  missingRequiredHeaders: string[];
  valid: boolean;
};
type ImportSummary = {
  created: number;
  updated: number;
  duplicates: number;
  failed: number;
  issues: Array<{ row: number; message: string; kind?: string }>;
};

export function ExportActions({
  type,
  filters = "",
  label = "Export",
}: {
  type: ExportType;
  filters?: string;
  label?: string;
}) {
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();
  async function run() {
    setBusy(true);
    try {
      await downloadExport(type, format, filters);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to export.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="inline-cluster">
      <Select
        aria-label={`${label} file format`}
        value={format}
        onValueChange={(value) => setFormat(value as typeof format)}
        disabled={busy}
      >
        <option value="csv">CSV</option>
        <option value="xlsx">Excel</option>
      </Select>
      <Button disabled={busy} onClick={() => void run()}>
        {busy ? "Exporting…" : label}
      </Button>
    </div>
  );
}

export function ImportRecords({
  initialType = "account",
  onImported,
}: {
  initialType?: ImportType;
  onImported?: () => void | Promise<void>;
}) {
  const [type, setType] = useState<ImportType>(initialType);
  const [mode, setMode] = useState<"create" | "upsert">("create");
  const [table, setTable] = useState<TransferTable | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();
  async function read(file?: File) {
    setTable(null);
    setPreview(null);
    setSummary(null);
    setFilename("");
    if (!file) return;
    setBusy(true);
    try {
      const result = await readTransferFile(file);
      setTable(result);
      setMapping(initialMapping(result.headers, type));
      setFilename(file.name);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to read file.", "error");
    } finally {
      setBusy(false);
    }
  }
  async function run(commit: boolean) {
    if (!table) return;
    setBusy(true);
    try {
      const body = JSON.stringify({ entityType: type, mode, csv: mappedCsv(table, mapping) });
      if (!commit) {
        setPreview(await api<ImportPreview>("/crm/import/preview", { method: "POST", body }));
      } else {
        const result = await api<ImportSummary>("/crm/import", { method: "POST", body });
        setSummary(result);
        setPreview(null);
        setTable(null);
        notify(
          `Import complete: ${result.created} created, ${result.duplicates} duplicates, ${result.failed} failed.`,
        );
        await onImported?.();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to import records.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-grid">
      <div className="field-wide">
        <p className="subtle-copy">
          Upload CSV or Excel (.xlsx), map columns, then preview before importing. Up to 2,000
          records / 5 MB. Excel uses the first worksheet. Leads become identified contacts linked to
          an existing company.
        </p>
      </div>
      <Field label="Record type">
        <Select
          value={type}
          disabled={busy}
          onValueChange={(value) => {
            const next = value as ImportType;
            setType(next);
            setPreview(null);
            setSummary(null);
            if (table) setMapping(initialMapping(table.headers, next));
          }}
        >
          <option value="account">Companies / accounts</option>
          <option value="contact">Contacts</option>
          <option value="lead">Leads</option>
        </Select>
      </Field>
      <Field label="Duplicate handling">
        <Select
          value={mode}
          disabled={busy}
          onValueChange={(value) => {
            setMode(value as typeof mode);
            setPreview(null);
          }}
        >
          <option value="create">Skip existing records</option>
          <option value="upsert">Update matching records</option>
        </Select>
      </Field>
      <div className="field-wide">
        <Field label="CSV or Excel file">
          <Input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(event) => void read(event.target.files?.[0])}
          />
        </Field>
      </div>
      {table ? (
        <>
          <div className="field-wide">
            <Badge tone="blue">
              {filename}: {table.rows.length} records
            </Badge>
            <p className="subtle-copy">
              Required: {type === "account" ? "Company name" : "First name and company domain"}.
              Unmapped columns are ignored.
            </p>
          </div>
          {table.headers.map((header, index) => (
            <Field key={header} label={`${header} → CRM field`}>
              <Select
                value={mapping[index] ?? ""}
                disabled={busy}
                onValueChange={(value) => {
                  setMapping((current) =>
                    current.map((field, position) => (position === index ? value : field)),
                  );
                  setPreview(null);
                }}
              >
                <option value="">Ignore column</option>
                {importFields[type].map((field) => (
                  <option
                    key={field}
                    value={field}
                    disabled={mapping.some(
                      (mapped, position) => position !== index && mapped === field,
                    )}
                  >
                    {titleCase(field)}
                  </option>
                ))}
              </Select>
              <span className="subtle-copy">
                Sample: {(table.rows[0]?.[index] || "Empty").slice(0, 100)}
              </span>
            </Field>
          ))}
          <div className="field-wide inline-cluster">
            <Button disabled={busy} onClick={() => void run(false)}>
              {busy ? "Working…" : "Preview import"}
            </Button>
            {preview?.valid ? (
              <Button variant="primary" disabled={busy} onClick={() => void run(true)}>
                Import {preview.rowCount} records
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {preview ? (
        <div className="field-wide" role="status">
          <Badge tone={preview.valid ? "green" : "red"}>
            {preview.valid
              ? `${preview.rowCount} rows ready`
              : `Missing fields: ${preview.missingRequiredHeaders.join(", ")}`}
          </Badge>
          <p className="subtle-copy">Records are validated and duplicates checked during import.</p>
        </div>
      ) : null}
      {summary ? (
        <div className="field-wide" role="status">
          <div className="inline-cluster">
            <Badge tone="green">{summary.created} imported</Badge>
            <Badge tone="blue">{summary.updated} updated</Badge>
            <Badge tone="amber">{summary.duplicates} duplicates skipped</Badge>
            <Badge tone={summary.failed ? "red" : "neutral"}>{summary.failed} failed</Badge>
          </div>
          {summary.issues.length ? (
            <>
              <p className="subtle-copy">
                {summary.issues.length} rows need review. Download the complete report to fix and
                retry them.
              </p>
              <Button
                onClick={() =>
                  downloadBlob(
                    new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" }),
                    "orbit-import-summary.json",
                  )
                }
              >
                Download import report
              </Button>
              <ul>
                {summary.issues.slice(0, 20).map((issue) => (
                  <li key={issue.row}>
                    Row {issue.row}: {issue.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TransferActions({
  type,
  filters,
  onImported,
}: {
  type: ImportType;
  filters: string;
  onImported: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Import</Button>
      <ExportActions type={type} filters={filters} label="Export filtered" />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import CRM records"
        description="Map your file to CRM fields. Existing ownership is preserved."
      >
        <ImportRecords initialType={type} onImported={onImported} />
      </Modal>
    </>
  );
}
