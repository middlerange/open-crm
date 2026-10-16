import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { initialMapping, mappedCsv, parseTransferCsv, readTransferFile } from "./crm-transfer";

test("CSV upload and mapped output preserve quoted notes and ignore unmapped columns", async () => {
  const csv =
    '\ufeffGiven name,Email address,Notes,Unrelated\r\nAda,ada@example.com,"Line one, with a comma\nLine two says ""hello""",ignore\r\n';
  const table = await readTransferFile(new File([csv], "contacts.csv"));
  const result = parseTransferCsv(mappedCsv(table, ["first_name", "email", "notes", ""]));
  assert.deepEqual(result.headers, ["first_name", "email", "notes"]);
  assert.deepEqual(result.rows, [
    ["Ada", "ada@example.com", 'Line one, with a comma\nLine two says "hello"'],
  ]);
});

test("mapping recognizes common headers without assigning one field twice", () => {
  assert.deepEqual(
    initialMapping(
      [" First Name ", "First", "Company Domain", "Email Address", "Job Title", "Unknown"],
      "contact",
    ),
    ["first_name", "", "account_domain", "email", "title", ""],
  );
  assert.deepEqual(initialMapping(["Company Name", "Website", "First Name"], "account"), [
    "name",
    "website_url",
    "",
  ]);
  assert.throws(
    () => mappedCsv({ headers: ["A", "B"], rows: [["a", "b"]] }, ["email", "email"]),
    /only be mapped once/,
  );
  assert.throws(() => mappedCsv({ headers: ["A"], rows: [["a"]] }, [""]), /Map at least one/);
});

test("location mapping keeps company and contact locations separate", () => {
  assert.deepEqual(initialMapping(["Country", "Company State", "Company City"], "account"), [
    "country",
    "state",
    "city",
  ]);
  assert.deepEqual(
    initialMapping(["Country", "State", "City", "Company State", "Company City"], "contact"),
    ["country", "state", "city", "", ""],
  );
});

test("CSV rejects ambiguous headers, malformed records and unsupported uploads", async () => {
  assert.throws(() => parseTransferCsv("Name, Name\nA,B"), /headers must be unique/);
  assert.throws(() => parseTransferCsv("Name,\nA,B"), /Every column needs a header/);
  assert.throws(() => parseTransferCsv('Name,Email\n"unterminated,email'), /Quote Not Closed/);
  await assert.rejects(readTransferFile(new File(["Name\n"], "empty.csv")), /1 to 2,000/);
  await assert.rejects(
    readTransferFile(new File(["Name\nAda"], "contacts.xls")),
    /Save older .xls/,
  );
});

test("Excel upload preserves text phones, hyperlink emails, rich text and cached formula values", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Contacts");
  sheet.addRow(["First Name", "Email Address", "Phone", "Notes", "Score"]);
  sheet.addRow([
    "Ada",
    { text: "ada@example.com", hyperlink: "mailto:ada@example.com" },
    "+001234567890",
    { richText: [{ text: "Line one, " }, { text: 'says "hello"' }] },
    { formula: "1+2", result: 3 },
  ]);
  sheet.addRow(["Grace", "grace@example.com", "00001234", "=1+1", ""]);
  workbook.addWorksheet("Ignored").addRow(["Another sheet"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const table = await readTransferFile(new File([new Uint8Array(buffer)], "contacts.XLSX"));
  assert.deepEqual(table.headers, ["First Name", "Email Address", "Phone", "Notes", "Score"]);
  assert.deepEqual(table.rows, [
    ["Ada", "ada@example.com", "+001234567890", 'Line one, says "hello"', "3"],
    ["Grace", "grace@example.com", "00001234", "=1+1", ""],
  ]);
  assert.deepEqual(
    parseTransferCsv(mappedCsv(table, ["first_name", "email", "phone", "notes", ""])).rows,
    [
      ["Ada", "ada@example.com", "+001234567890", 'Line one, says "hello"'],
      ["Grace", "grace@example.com", "00001234", "=1+1"],
    ],
  );
});

test("Excel export-style string cells remain strings rather than executable formulas", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("CRM records");
  const source = parseTransferCsv(
    'email,phone,notes\nada@example.com,+0012345,"=HYPERLINK(""https://example.com"")"',
  );
  sheet.addRow(source.headers);
  sheet.addRows(source.rows);
  const buffer = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.equal(restored.worksheets[0].getCell("C2").type, ExcelJS.ValueType.String);
  assert.equal(restored.worksheets[0].getCell("C2").formula, undefined);
  assert.deepEqual(
    await readTransferFile(new File([new Uint8Array(buffer)], "export.xlsx")),
    source,
  );
});
