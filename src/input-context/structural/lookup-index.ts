import type { StructuralContextResult } from "./domain.js";

export interface StructuralLookupRow {
  readonly key: string;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly kind: string;
  readonly name: string;
  readonly start_line: number;
  readonly end_line: number;
}

export interface StructuralLookupResult {
  readonly status: "CURRENT" | "PARTIAL" | "NO_INDEX";
  readonly rows: readonly StructuralLookupRow[];
  readonly requires_source_confirmation: true;
}

function normalized(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-US"); }

export class StructuralLookupIndex {
  private rows: StructuralLookupRow[] = [];
  private truncated = false;

  constructor(private readonly maxRows = 50_000) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000) {
      throw new RangeError("Structural lookup row bound is invalid");
    }
  }

  rebuild(results: readonly StructuralContextResult[]): { readonly indexed: number; readonly truncated: boolean } {
    const rows = results.flatMap((result) => result.entries.map((entry): StructuralLookupRow => ({
      key: normalized(entry.name), source_path: result.source_path, source_sha256: result.source_sha256,
      kind: entry.kind, name: entry.name, start_line: entry.start_line, end_line: entry.end_line,
    })));
    rows.sort((left, right) => left.key.localeCompare(right.key, "en-US")
      || left.source_path.localeCompare(right.source_path, "en-US") || left.start_line - right.start_line);
    this.truncated = rows.length > this.maxRows;
    this.rows = rows.slice(0, this.maxRows);
    return { indexed: this.rows.length, truncated: this.truncated };
  }

  lookup(query: string, limit = 20): StructuralLookupResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Structural lookup result bound is invalid");
    if (this.rows.length === 0) return { status: "NO_INDEX", rows: [], requires_source_confirmation: true };
    const key = normalized(query.trim());
    if (!key) return { status: "PARTIAL", rows: [], requires_source_confirmation: true };
    let low = 0;
    let high = this.rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rows[middle]!.key < key) low = middle + 1;
      else high = middle;
    }
    const matches: StructuralLookupRow[] = [];
    for (let index = low; index < this.rows.length && matches.length < limit; index += 1) {
      const row = this.rows[index]!;
      if (!row.key.startsWith(key)) break;
      matches.push(row);
    }
    return { status: this.truncated ? "PARTIAL" : "CURRENT", rows: matches, requires_source_confirmation: true };
  }

  clear(): void { this.rows = []; this.truncated = false; }
  size(): number { return this.rows.length; }
}
