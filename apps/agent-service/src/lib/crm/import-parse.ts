export type ImportEntity = "leads" | "contacts" | "opportunities";
export type ImportMode = "add_update" | "add_only" | "update_only";

export interface ParsedSpreadsheet {
  fileName: string;
  columns: string[];
  rows: Record<string, string>[];
}

export interface ImportFieldOption {
  value: string;
  label: string;
  keywords: string[];
}

export const LEAD_IMPORT_FIELDS: ImportFieldOption[] = [
  { value: "full_name", label: "Full name", keywords: ["full name", "name", "contact", "lead"] },
  { value: "first_name", label: "First name", keywords: ["first name", "firstname", "first"] },
  { value: "last_name", label: "Last name", keywords: ["last name", "lastname", "last", "surname"] },
  { value: "phone", label: "Phone", keywords: ["phone", "mobile", "cell", "telephone", "sms"] },
  { value: "email", label: "Email", keywords: ["email", "e mail", "e-mail", "mail"] },
  { value: "status", label: "Status", keywords: ["status", "lead status", "stage"] },
  { value: "skip", label: "— Do not import —", keywords: [] },
];

export const OPPORTUNITY_IMPORT_FIELDS: ImportFieldOption[] = [
  { value: "name", label: "Opportunity name", keywords: ["name", "opportunity", "deal", "title"] },
  { value: "stage", label: "Stage", keywords: ["stage", "pipeline", "status"] },
  { value: "amount", label: "Amount", keywords: ["amount", "value", "price", "gci"] },
  {
    value: "close_date",
    label: "Expected close date",
    keywords: ["close date", "expected close", "closing", "close"],
  },
  { value: "notes", label: "Notes", keywords: ["notes", "note", "comments", "description"] },
  {
    value: "lead_name",
    label: "Related lead name",
    keywords: ["lead", "lead name", "contact", "contact name"],
  },
  { value: "skip", label: "— Do not import —", keywords: [] },
];

export function fieldsForEntity(entity: ImportEntity): ImportFieldOption[] {
  return entity === "opportunities" ? OPPORTUNITY_IMPORT_FIELDS : LEAD_IMPORT_FIELDS;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function suggestMapping(
  columns: string[],
  entity: ImportEntity,
): Record<string, string> {
  const fields = fieldsForEntity(entity).filter((field) => field.value !== "skip");
  const used = new Set<string>();
  const mapping: Record<string, string> = {};

  for (const column of columns) {
    const normalized = normalizeHeader(column);
    let best: ImportFieldOption | null = null;

    for (const field of fields) {
      if (used.has(field.value)) continue;
      if (field.keywords.some((keyword) => normalized === keyword || normalized.includes(keyword))) {
        best = field;
        break;
      }
    }

    if (best) {
      mapping[column] = best.value;
      used.add(best.value);
    } else {
      mapping[column] = "skip";
    }
  }

  return mapping;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function rowsFromMatrix(matrix: string[][]): ParsedSpreadsheet["rows"] {
  if (matrix.length < 2) return [];
  const headerRow = matrix[0] ?? [];
  const columns = headerRow.map((cell, index) => cell.trim() || `Column ${index + 1}`);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < matrix.length; i += 1) {
    const line = matrix[i] ?? [];
    if (line.every((cell) => !String(cell ?? "").trim())) continue;
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = String(line[index] ?? "").trim();
    });
    rows.push(row);
  }

  return rows;
}

export function parseCsvText(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0);

  const matrix = lines.map(parseCsvLine);
  const headerRow = matrix[0] ?? [];
  const columns = headerRow.map((cell, index) => cell.trim() || `Column ${index + 1}`);
  return { columns, rows: rowsFromMatrix(matrix) };
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedSpreadsheet> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".csv") || file.type === "text/csv" || file.type === "text/plain") {
    const text = await file.text();
    const parsed = parseCsvText(text);
    if (parsed.columns.length === 0) {
      throw new Error("No columns found in that CSV.");
    }
    return { fileName: file.name, ...parsed };
  }

  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    file.type.includes("spreadsheet") ||
    file.type.includes("excel")
  ) {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("That spreadsheet has no sheets.");
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    }) as string[][];
    const headerRow = matrix[0] ?? [];
    const columns = headerRow.map((cell, index) => String(cell ?? "").trim() || `Column ${index + 1}`);
    const rows = rowsFromMatrix(matrix.map((row) => row.map((cell) => String(cell ?? ""))));
    if (columns.length === 0) throw new Error("No columns found in that spreadsheet.");
    return { fileName: file.name, columns, rows };
  }

  throw new Error("Upload a CSV or Excel file (.csv, .xlsx, .xls).");
}

export function mappedCount(mapping: Record<string, string>): number {
  return Object.values(mapping).filter((value) => value !== "skip").length;
}

export function getMappedValue(
  row: Record<string, string>,
  mapping: Record<string, string>,
  field: string,
): string {
  const column = Object.entries(mapping).find(([, value]) => value === field)?.[0];
  if (!column) return "";
  return row[column]?.trim() ?? "";
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}
