import type { TransactionSql } from "postgres";

export type SortDirection = "asc" | "desc";

export type PaginationInput = {
  page?: number | string | null;
  pageSize?: number | string | null;
};

export type PaginationOptions = {
  defaultPageSize?: number;
  maxPageSize?: number;
  maxPage?: number;
};

export function normalizePagination(input: PaginationInput = {}, options: PaginationOptions = {}) {
  const defaultPageSize = positiveInteger(options.defaultPageSize) ?? 25;
  const maxPageSize = positiveInteger(options.maxPageSize) ?? 100;
  const maxPage = positiveInteger(options.maxPage) ?? 100_000;
  if (defaultPageSize > maxPageSize) {
    throw new RangeError("defaultPageSize cannot exceed maxPageSize.");
  }

  const requestedPage = positiveInteger(input.page);
  const requestedPageSize = positiveInteger(input.pageSize);
  const page = Math.min(requestedPage ?? 1, maxPage);
  const pageSize = Math.min(requestedPageSize ?? defaultPageSize, maxPageSize);

  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function resolveAllowedSort<T>(
  requestedSort: string | null | undefined,
  requestedDirection: string | null | undefined,
  allowedSorts: Readonly<Record<string, T>>,
  fallbackSort: string,
  fallbackDirection: SortDirection = "asc",
) {
  if (!Object.hasOwn(allowedSorts, fallbackSort)) {
    throw new Error(`Fallback sort "${fallbackSort}" is not allowlisted.`);
  }

  const sort =
    requestedSort && Object.hasOwn(allowedSorts, requestedSort) ? requestedSort : fallbackSort;
  const direction =
    requestedDirection === "asc" || requestedDirection === "desc"
      ? requestedDirection
      : fallbackDirection;

  return { sort, direction, value: allowedSorts[sort] as T };
}

const RESERVED_FIELD_KEYS = new Set([
  "id",
  "created_at",
  "updated_at",
  "archived_at",
  "workspace_id",
  "owner_id",
  "fields",
]);

export function normalizeCustomFieldKey(label: string, maxLength = 60) {
  if (!Number.isInteger(maxLength) || maxLength < 8) {
    throw new RangeError("maxLength must be an integer of at least 8.");
  }

  let key = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (/^[0-9]/.test(key)) key = `f_${key}`;
  key = key.slice(0, maxLength).replace(/_+$/g, "");
  if (RESERVED_FIELD_KEYS.has(key)) {
    const suffix = "_field";
    key = `${key.slice(0, maxLength - suffix.length).replace(/_+$/g, "")}${suffix}`;
  }

  return key;
}

export type CsvValue = string | number | boolean | Date | null | undefined;

export function escapeCsvCell(value: CsvValue) {
  let text = value instanceof Date ? value.toISOString() : value == null ? "" : String(value);
  if (typeof value === "string" && /^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function serializeCsv(
  headers: readonly string[],
  rows: readonly Readonly<Record<string, CsvValue>>[],
  options: { lineEnding?: "\n" | "\r\n"; includeBom?: boolean } = {},
) {
  validateHeaders(headers);
  const lineEnding = options.lineEnding ?? "\r\n";
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(",")),
  ];
  return `${options.includeBom ? "\uFEFF" : ""}${lines.join(lineEnding)}${lineEnding}`;
}

export type ParseCsvOptions = {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellLength?: number;
  skipEmptyLines?: boolean;
};

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

export class CsvParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} at line ${line}, column ${column}.`);
    this.name = "CsvParseError";
    this.line = line;
    this.column = column;
  }
}

export function parseCsv(input: string, options: ParseCsvOptions = {}): ParsedCsv {
  const maxBytes = positiveInteger(options.maxBytes) ?? 5_000_000;
  const maxRows = positiveInteger(options.maxRows) ?? 10_000;
  const maxColumns = positiveInteger(options.maxColumns) ?? 200;
  const maxCellLength = positiveInteger(options.maxCellLength) ?? 100_000;
  const skipEmptyLines = options.skipEmptyLines ?? true;

  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    throw new CsvParseError(`CSV exceeds the ${maxBytes}-byte limit`, 1, 1);
  }
  if (input.includes("\0")) throw new CsvParseError("CSV contains a NUL byte", 1, 1);

  const source = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const parsedRows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let endedWithSeparator = false;
  let line = 1;
  let column = 1;

  const pushField = () => {
    if (field.length > maxCellLength) {
      throw new CsvParseError(`Cell exceeds the ${maxCellLength}-character limit`, line, column);
    }
    row.push(field);
    field = "";
    afterQuote = false;
    if (row.length > maxColumns) {
      throw new CsvParseError(`Row exceeds the ${maxColumns}-column limit`, line, column);
    }
  };

  const pushRow = () => {
    pushField();
    const empty = row.length === 1 && row[0] === "";
    if (!(skipEmptyLines && empty)) parsedRows.push(row);
    row = [];
    if (parsedRows.length > maxRows + 1) {
      throw new CsvParseError(`CSV exceeds the ${maxRows}-data-row limit`, line, column);
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    endedWithSeparator = false;

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
          column += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
      } else {
        field += character;
      }
    } else if (afterQuote) {
      if (character === ",") {
        pushField();
      } else if (character === "\n" || character === "\r") {
        pushRow();
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        endedWithSeparator = true;
        line += 1;
        column = 1;
        continue;
      } else {
        throw new CsvParseError("Unexpected character after a closing quote", line, column);
      }
    } else if (character === '"') {
      if (field.length > 0) {
        throw new CsvParseError("Quote found inside an unquoted field", line, column);
      }
      inQuotes = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\n" || character === "\r") {
      pushRow();
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      endedWithSeparator = true;
      line += 1;
      column = 1;
      continue;
    } else {
      field += character;
    }

    if (character === "\n" || character === "\r") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  if (inQuotes) throw new CsvParseError("Unclosed quoted field", line, column);
  if (!endedWithSeparator && (field.length > 0 || row.length > 0 || afterQuote)) pushRow();
  if (parsedRows.length === 0) throw new CsvParseError("CSV has no header row", 1, 1);

  const headers = parsedRows.shift()!.map((header) => header.trim());
  validateHeaders(headers);

  const rows = parsedRows.map((values, index) => {
    if (values.length !== headers.length) {
      throw new CsvParseError(
        `Row has ${values.length} columns; expected ${headers.length}`,
        index + 2,
        1,
      );
    }
    return Object.fromEntries(
      headers.map((header, valueIndex) => [header, values[valueIndex] ?? ""]),
    );
  });

  return { headers, rows };
}

function positiveInteger(value: unknown) {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validateHeaders(headers: readonly string[], line = 1, column = 1) {
  if (headers.length === 0) throw new CsvParseError("CSV needs at least one header", line, column);
  const seen = new Set<string>();
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    if (!normalized) throw new CsvParseError("CSV contains a blank header", line, column);
    if (seen.has(normalized)) {
      throw new CsvParseError(`CSV contains duplicate header "${header}"`, line, column);
    }
    seen.add(normalized);
  }
}

export async function cascadeAccountOwner(
  transaction: TransactionSql,
  workspaceId: string,
  accountIds: readonly string[],
) {
  await transaction`
    UPDATE contacts c SET owner_id = a.owner_id
    FROM accounts a
    WHERE a.id = c.account_id AND a.workspace_id = ${workspaceId} AND c.workspace_id = ${workspaceId}
      AND a.id = ANY(${accountIds}::uuid[]) AND c.owner_id IS DISTINCT FROM a.owner_id
  `;
  await transaction`
    UPDATE opportunities o SET owner_id = a.owner_id
    FROM accounts a
    WHERE a.id = o.account_id AND a.workspace_id = ${workspaceId} AND o.workspace_id = ${workspaceId}
      AND a.id = ANY(${accountIds}::uuid[]) AND o.owner_id IS DISTINCT FROM a.owner_id
  `;
}
