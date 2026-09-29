import type {
  AppendResult,
  BatchOperation,
  BatchResult,
  CellValue,
  ReadResult,
  RenderMode,
  SearchResult,
  SheetInfo,
  SheetsGateway,
  SpreadsheetInfo,
  SpreadsheetMetadata,
  WriteResult,
} from "./gateway.js";
import { GatewayError } from "./gateway.js";
import {
  validateBatch,
  validateReadRange,
  validateSearch,
  validateSheetName,
  validateValues,
  validateWrite,
} from "./validation.js";

export interface SheetsServiceOptions {
  cacheTtlMs?: number;
  now?: () => number;
}

const MIN_REFRESH_ON_MISS_MS = 2_000;

/** Business layer: resolves spreadsheet references, validates input, enforces access; depends only on the port. */
export class SheetsService {
  private cache: { at: number; items: SpreadsheetInfo[] } | null = null;
  private inflight: Promise<SpreadsheetInfo[]> | null = null;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(
    private readonly gateway: SheetsGateway,
    opts: SheetsServiceOptions = {},
  ) {
    this.ttl = opts.cacheTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  invalidate(): void {
    this.cache = null;
  }

  async listSpreadsheets(): Promise<SpreadsheetInfo[]> {
    return this.list(false);
  }

  private async list(force: boolean): Promise<SpreadsheetInfo[]> {
    if (!force && this.cache && this.now() - this.cache.at < this.ttl) return this.cache.items;
    if (!this.inflight) {
      this.inflight = this.gateway
        .listSpreadsheets()
        .then((items) => {
          this.cache = { at: this.now(), items };
          return items;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** alias -> exact name -> ID. Ambiguity is an error that lists the candidates. */
  async resolve(ref: string): Promise<SpreadsheetInfo> {
    if (typeof ref !== "string" || ref.trim() === "") {
      throw new GatewayError("BAD_REQUEST", "spreadsheet must be an alias, exact name or ID.");
    }
    const r = ref.trim();
    let items = await this.list(false);
    let hit = this.match(items, r);
    if (!hit && this.cache && this.now() - this.cache.at >= MIN_REFRESH_ON_MISS_MS) {
      items = await this.list(true); // maybe it was just authorized in Apps Script
      hit = this.match(items, r);
    }
    if (hit) return hit;
    const available = items.map((s) => `"${s.alias ?? s.name}"`).slice(0, 20).join(", ");
    throw new GatewayError(
      "SPREADSHEET_NOT_AUTHORIZED",
      `No authorized spreadsheet matches "${r}". ` +
        (items.length ? `Authorized: ${available}. ` : "None are authorized yet. ") +
        "Use list_spreadsheets to see them; the owner manages the list in the Apps Script page.",
    );
  }

  private match(items: SpreadsheetInfo[], r: string): SpreadsheetInfo | null {
    const lower = r.toLowerCase();
    const tiers: Array<(s: SpreadsheetInfo) => boolean> = [
      (s) => s.alias !== null && s.alias !== "" && s.alias.trim().toLowerCase() === lower,
      (s) => s.name === r,
      (s) => s.id === r,
    ];
    for (const t of tiers) {
      const found = items.filter(t);
      if (found.length === 1) return found[0]!;
      if (found.length > 1) {
        const list = found.map((s) => `${s.name} (id ${s.id}${s.alias ? `, alias ${s.alias}` : ""})`).join("; ");
        throw new GatewayError("BAD_REQUEST", `"${r}" is ambiguous; it matches: ${list}. Pass the spreadsheet ID instead.`);
      }
    }
    return null;
  }

  private requireWrite(s: SpreadsheetInfo): void {
    if (s.access !== "write") {
      throw new GatewayError(
        "WRITE_NOT_ALLOWED",
        `Spreadsheet "${s.alias ?? s.name}" is authorized read-only. The owner can grant write access in the Apps Script page.`,
      );
    }
  }

  async getMetadata(ref: string): Promise<SpreadsheetMetadata> {
    const s = await this.resolve(ref);
    return this.gateway.getMetadata(s.id);
  }

  async listSheets(ref: string): Promise<{ spreadsheet: string; sheets: SheetInfo[] }> {
    const m = await this.getMetadata(ref);
    return { spreadsheet: m.name, sheets: m.sheets };
  }

  async readRange(ref: string, range: string, render?: RenderMode): Promise<ReadResult> {
    validateReadRange(range);
    const s = await this.resolve(ref);
    return this.gateway.readRange({ spreadsheetId: s.id, range, ...(render ? { render } : {}) });
  }

  async search(
    ref: string,
    q: { query: string; sheet?: string; matchCase?: boolean; matchEntireCell?: boolean; limit?: number },
  ): Promise<SearchResult> {
    validateSearch(q.query, q.limit, q.sheet);
    const s = await this.resolve(ref);
    return this.gateway.search({ spreadsheetId: s.id, ...q });
  }

  async writeRange(ref: string, range: string, values: CellValue[][], allowFormulas = false): Promise<WriteResult> {
    validateWrite(range, values, allowFormulas);
    const s = await this.resolve(ref);
    this.requireWrite(s);
    return this.gateway.writeRange({ spreadsheetId: s.id, range, values, allowFormulas });
  }

  async appendRows(ref: string, sheet: string, rows: CellValue[][], allowFormulas = false): Promise<AppendResult> {
    validateSheetName(sheet);
    validateValues(rows, allowFormulas, "rows");
    const s = await this.resolve(ref);
    this.requireWrite(s);
    return this.gateway.appendRows({ spreadsheetId: s.id, sheet, rows, allowFormulas });
  }

  async batchUpdate(ref: string, operations: BatchOperation[], allowFormulas = false): Promise<BatchResult> {
    validateBatch(operations, allowFormulas);
    const s = await this.resolve(ref);
    this.requireWrite(s);
    return this.gateway.batchUpdate({ spreadsheetId: s.id, operations, allowFormulas });
  }
}
