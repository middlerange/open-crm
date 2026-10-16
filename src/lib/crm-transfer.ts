import { parse } from "csv-parse/browser/esm/sync";

export type ImportType = "account" | "contact" | "lead";
export type ExportType = ImportType | "opportunity";
export type TransferTable = { headers: string[]; rows: string[][] };

export const importFields: Record<ImportType, string[]> = {
  account: [
    "name",
    "domain",
    "linkedin_url",
    "website_url",
    "tier",
    "industry",
    "country",
    "state",
    "city",
    "employee_range",
    "product_motion",
    "source",
    "fit_summary",
    "evidence_summary",
    "trigger_summary",
    "score",
    "external_source",
    "external_id",
  ],
  contact: [
    "first_name",
    "last_name",
    "account_domain",
    "email",
    "linkedin_url",
    "title",
    "department",
    "country",
    "state",
    "city",
    "phone",
    "buyer_role",
    "notes",
    "external_source",
    "external_id",
  ],
  lead: [
    "first_name",
    "last_name",
    "account_domain",
    "email",
    "linkedin_url",
    "title",
    "department",
    "country",
    "state",
    "city",
    "phone",
    "buyer_role",
    "notes",
    "external_source",
    "external_id",
  ],
};

export function parseTransferCsv(csv: string): TransferTable {
  const records = parse(csv, {
    bom: true,
    skip_empty_lines: true,
    max_record_size: 1_000_000,
  }) as string[][];
  return validateTable({ headers: records[0] ?? [], rows: records.slice(1) });
}

function validateTable(table: TransferTable): TransferTable {
  const headers = table.headers.map((header) => header.trim());
  if (!headers.length || headers.some((header) => !header))
    throw new Error("Every column needs a header in the first row.");
  if (new Set(headers).size !== headers.length) throw new Error("Column headers must be unique.");
  if (headers.length > 200) throw new Error("Files may contain at most 200 columns.");
  return { ...table, headers };
}

export function initialMapping(headers: string[], type: ImportType): string[] {
  const aliases: Record<string, string> = {
    company: "name",
    company_name: "name",
    company_country: type === "account" ? "country" : "",
    company_state: type === "account" ? "state" : "",
    company_city: type === "account" ? "city" : "",
    company_domain: type === "account" ? "domain" : "account_domain",
    industry_vertical: "industry",
    vertical: "industry",
    website: "website_url",
    first: "first_name",
    last: "last_name",
    email_address: "email",
    linkedin: "linkedin_url",
    job_title: "title",
  };
  const used = new Set<string>();
  return headers.map((header) => {
    const key = header
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const field = importFields[type].includes(key) ? key : aliases[key];
    if (!field || !importFields[type].includes(field) || used.has(field)) return "";
    used.add(field);
    return field;
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function mappedCsv(table: TransferTable, mapping: string[]): string {
  const columns = mapping.flatMap((field, index) => (field ? [{ field, index }] : []));
  if (!columns.length) throw new Error("Map at least one column before previewing.");
  if (new Set(columns.map((column) => column.field)).size !== columns.length)
    throw new Error("Each CRM field can only be mapped once.");
  return [
    columns.map((column) => column.field),
    ...table.rows.map((row) => columns.map((column) => row[column.index] ?? "")),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export async function readTransferFile(file: File): Promise<TransferTable> {
  if (file.size > 5_000_000) throw new Error("Files must be smaller than 5 MB.");
  let table: TransferTable;
  if (/\.xlsx$/i.test(file.name)) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The workbook has no worksheets.");
    if (sheet.rowCount > 2_001 || sheet.columnCount > 200)
      throw new Error("Files may contain at most 2,000 records and 200 columns.");
    const records: string[][] = [];
    for (let row = 1; row <= sheet.rowCount; row += 1) {
      const cells = Array.from(
        { length: sheet.columnCount },
        (_, index) => sheet.getRow(row).getCell(index + 1).text,
      );
      if (cells.some((cell) => cell.trim())) records.push(cells);
    }
    table = validateTable({ headers: records[0] ?? [], rows: records.slice(1) });
  } else if (/\.csv$/i.test(file.name)) {
    table = parseTransferCsv(await file.text());
  } else {
    throw new Error("Choose a CSV or Excel (.xlsx) file. Save older .xls files as .xlsx first.");
  }
  if (!table.rows.length || table.rows.length > 2_000)
    throw new Error("Choose a file with 1 to 2,000 records.");
  return table;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadExport(
  type: ExportType,
  format: "csv" | "xlsx",
  filters = "",
): Promise<void> {
  const response = await fetch(`/api/crm/export/${type}?${filters}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "Unable to export records.");
  }
  const csv = await response.text();
  const collection = type === "opportunity" ? "opportunities" : `${type}s`;
  const filename = `orbit-${collection}-${new Date().toISOString().slice(0, 10)}`;
  if (format === "csv") {
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${filename}.csv`);
    return;
  }
  const table = parseTransferCsv(csv);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("CRM records");
  sheet.addRow(table.headers);
  sheet.addRows(table.rows);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns.forEach((column) => {
    column.width = 24;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${filename}.xlsx`,
  );
}
