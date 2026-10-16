import assert from "node:assert/strict";
import test from "node:test";

import {
  CsvParseError,
  escapeCsvCell,
  normalizeCustomFieldKey,
  normalizePagination,
  parseCsv,
  resolveAllowedSort,
  serializeCsv,
} from "./crm-utils";

test("pagination accepts integer query values and applies safe bounds", () => {
  assert.deepEqual(normalizePagination({ page: "3", pageSize: "50" }), {
    page: 3,
    pageSize: 50,
    limit: 50,
    offset: 100,
  });
  assert.deepEqual(normalizePagination({ page: "-2", pageSize: "500" }), {
    page: 1,
    pageSize: 100,
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(normalizePagination({ page: "999", pageSize: "20" }, { maxPage: 10 }), {
    page: 10,
    pageSize: 20,
    limit: 20,
    offset: 180,
  });
  assert.throws(
    () => normalizePagination({}, { defaultPageSize: 101, maxPageSize: 100 }),
    /cannot exceed/,
  );
});

test("sort resolution returns only allowlisted values and directions", () => {
  const allowed = { name: "a.name", activity: "a.last_activity_at" } as const;
  assert.deepEqual(resolveAllowedSort("activity", "desc", allowed, "name"), {
    sort: "activity",
    direction: "desc",
    value: "a.last_activity_at",
  });
  assert.deepEqual(resolveAllowedSort("a.name; DROP TABLE accounts", "sideways", allowed, "name"), {
    sort: "name",
    direction: "asc",
    value: "a.name",
  });
  assert.throws(() => resolveAllowedSort("name", "asc", allowed, "missing"), /not allowlisted/);
});

test("custom field keys are stable, ASCII, bounded, and avoid reserved names", () => {
  assert.equal(normalizeCustomFieldKey(" Annual Recurring Revenue "), "annual_recurring_revenue");
  assert.equal(normalizeCustomFieldKey("Résumé / ICP fit"), "resume_icp_fit");
  assert.equal(normalizeCustomFieldKey("Founder’s priority"), "founders_priority");
  assert.equal(normalizeCustomFieldKey("2027 Plan"), "f_2027_plan");
  assert.equal(normalizeCustomFieldKey("owner_id"), "owner_id_field");
  assert.equal(normalizeCustomFieldKey("***"), "");
  assert.equal(normalizeCustomFieldKey("A very long field name", 10), "a_very_lon");
});

test("CSV escaping quotes delimiters and neutralizes spreadsheet formulas in strings", () => {
  assert.equal(escapeCsvCell("plain"), "plain");
  assert.equal(escapeCsvCell('A, "quoted" value'), '"A, ""quoted"" value"');
  assert.equal(escapeCsvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(
    escapeCsvCell('=HYPERLINK("https://bad.example")'),
    '"\'=HYPERLINK(""https://bad.example"")"',
  );
  assert.equal(escapeCsvCell("  +cmd"), "'  +cmd");
  assert.equal(escapeCsvCell(-42), "-42");
});

test("CSV serialization follows header order and produces importable output", () => {
  const csv = serializeCsv(
    ["Name", "Notes", "Score", "Formula"],
    [
      { Name: "Acme", Notes: "One, two", Score: 42, Formula: "@SUM(A1:A2)" },
      { Name: 'Quote "Co"', Notes: "Line 1\nLine 2", Score: null, Formula: "safe" },
    ],
  );
  assert.equal(
    csv,
    'Name,Notes,Score,Formula\r\nAcme,"One, two",42,\'@SUM(A1:A2)\r\n"Quote ""Co""","Line 1\nLine 2",,safe\r\n',
  );
  assert.deepEqual(parseCsv(csv), {
    headers: ["Name", "Notes", "Score", "Formula"],
    rows: [
      { Name: "Acme", Notes: "One, two", Score: "42", Formula: "'@SUM(A1:A2)" },
      { Name: 'Quote "Co"', Notes: "Line 1\nLine 2", Score: "", Formula: "safe" },
    ],
  });
});

test("CSV parsing supports BOM, CRLF, quoted commas, quotes, and embedded newlines", () => {
  const parsed = parseCsv(
    '\uFEFFName,Email,Notes\r\n"Doe, Jane",jane@example.com,"Said ""hello""\r\nagain"\r\n',
  );
  assert.deepEqual(parsed, {
    headers: ["Name", "Email", "Notes"],
    rows: [
      {
        Name: "Doe, Jane",
        Email: "jane@example.com",
        Notes: 'Said "hello"\r\nagain',
      },
    ],
  });
});

test("CSV parsing rejects malformed or unsafe import shapes", () => {
  const cases = [
    "Name,Name\nAcme,Acme",
    "Name,Email\nAcme",
    'Name\n"unclosed',
    'Name\n"closed"junk',
    'Name\nnot"quoted',
    "Name\ncontains\0nul",
  ];
  for (const csv of cases) assert.throws(() => parseCsv(csv), CsvParseError);

  assert.throws(() => parseCsv("Name\nAcme", { maxBytes: 4 }), /byte limit/);
  assert.throws(() => parseCsv("A,B,C\n1,2,3", { maxColumns: 2 }), /column limit/);
  assert.throws(() => parseCsv("Name\nAcme\nOrbit", { maxRows: 1 }), /data-row limit/);
  assert.throws(() => parseCsv("Name\nAcme", { maxCellLength: 3 }), /character limit/);
});
