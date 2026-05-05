import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { CsvRowError } from '../types.js';

const RESERVED_COLUMNS = new Set(['url_a', 'url_b', 'label']);

// URL parsing is lenient: we just need a syntactically valid absolute URL.
// `http(s)://` is required so a typo like `wwww.example.com` doesn't slip
// through.
const urlSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine(
    (value) => {
      try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be a valid http(s) URL' },
  );

export const csvRowSchema = z
  .object({
    url_a: urlSchema,
    url_b: urlSchema,
    label: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .strip(); // we capture extras separately

export interface ParsedCsvRow {
  url_a: string;
  url_b: string;
  label: string | undefined;
  raw_row: Record<string, string>;
}

export interface ParseCsvSuccess {
  ok: true;
  rows: ParsedCsvRow[];
}

export interface ParseCsvFailure {
  ok: false;
  message: string;
  row_errors?: CsvRowError[];
}

export type ParseCsvResult = ParseCsvSuccess | ParseCsvFailure;

export function parseSessionCsv(text: string): ParseCsvResult {
  let raw: Record<string, string>[];
  try {
    raw = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: false,
    }) as Record<string, string>[];
  } catch (err) {
    return {
      ok: false,
      message: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (raw.length === 0) {
    return { ok: false, message: 'CSV has no data rows.' };
  }

  const headers = Object.keys(raw[0] ?? {});
  const missing: string[] = [];
  if (!headers.includes('url_a')) missing.push('url_a');
  if (!headers.includes('url_b')) missing.push('url_b');
  if (missing.length > 0) {
    return {
      ok: false,
      message: `CSV is missing required column(s): ${missing.join(', ')}.`,
    };
  }

  const errors: CsvRowError[] = [];
  const rows: ParsedCsvRow[] = [];

  raw.forEach((rawRow, idx) => {
    const result = csvRowSchema.safeParse(rawRow);
    if (!result.success) {
      errors.push({
        row_index: idx,
        errors: result.error.issues.map((iss) => {
          const path = iss.path.join('.');
          return path ? `${path}: ${iss.message}` : iss.message;
        }),
      });
      return;
    }

    rows.push({
      url_a: result.data.url_a,
      url_b: result.data.url_b,
      label: result.data.label,
      raw_row: rawRow,
    });
  });

  if (errors.length > 0) {
    return {
      ok: false,
      message: `CSV has ${errors.length} invalid row(s).`,
      row_errors: errors,
    };
  }

  return { ok: true, rows };
}

export { RESERVED_COLUMNS };
