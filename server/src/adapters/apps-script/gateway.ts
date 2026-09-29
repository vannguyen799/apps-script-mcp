import type {
  AppendRequest,
  AppendResult,
  BatchRequest,
  BatchResult,
  PingResult,
  ReadRequest,
  ReadResult,
  SearchRequest,
  SearchResult,
  SheetsGateway,
  SpreadsheetInfo,
  SpreadsheetMetadata,
  WriteRequest,
  WriteResult,
} from "../../core/sheets/gateway.js";
import { GatewayError } from "../../core/sheets/gateway.js";
import type { Logger } from "../../log.js";
import { nullLogger } from "../../log.js";

/** Minimal surface of the signed client, so tests can substitute it. */
export interface CallClient {
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Adapter: SheetsGateway over the Apps Script wire protocol (DESIGN.md 4.5 action names). */
export class AppsScriptGateway implements SheetsGateway {
  constructor(
    private readonly client: CallClient,
    private readonly log: Logger = nullLogger,
  ) {}

  private async run<T>(action: string, params: Record<string, unknown>, meta: { spreadsheetId?: string; cellCount?: number } = {}): Promise<T> {
    const t0 = Date.now();
    try {
      const r = (await this.client.call(action, params)) as T;
      this.log.info("sheets_action", { action, spreadsheetId: meta.spreadsheetId, cellCount: meta.cellCount, durationMs: Date.now() - t0, resultCode: "OK" });
      return r;
    } catch (e) {
      this.log.info("sheets_action", {
        action,
        spreadsheetId: meta.spreadsheetId,
        durationMs: Date.now() - t0,
        resultCode: e instanceof GatewayError ? e.code : "INTERNAL",
      });
      throw e;
    }
  }

  async ping(): Promise<PingResult> {
    const r = await this.run<{ account?: string; scriptVersion?: string | number; spreadsheetCount?: number }>("ping", {});
    if (typeof r?.account !== "string") throw new GatewayError("INTERNAL", "Unexpected ping result.");
    return {
      account: r.account,
      backendVersion: r.scriptVersion === undefined ? null : String(r.scriptVersion),
      spreadsheetCount: Number(r.spreadsheetCount ?? 0),
    };
  }

  async listSpreadsheets(): Promise<SpreadsheetInfo[]> {
    const r = await this.run<{ spreadsheets?: Array<Partial<SpreadsheetInfo>> }>("spreadsheets.list", {});
    if (!Array.isArray(r?.spreadsheets)) throw new GatewayError("INTERNAL", "Unexpected spreadsheet list.");
    return r.spreadsheets.map((s) => ({
      id: String(s.id),
      name: String(s.name ?? ""),
      alias: s.alias ? String(s.alias) : null,
      access: s.access === "write" ? "write" : "read",
      url: String(s.url ?? ""),
    }));
  }

  getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    return this.run("spreadsheet.metadata", { spreadsheetId }, { spreadsheetId });
  }

  readRange(req: ReadRequest): Promise<ReadResult> {
    return this.run("range.read", { spreadsheetId: req.spreadsheetId, range: req.range, render: req.render }, { spreadsheetId: req.spreadsheetId });
  }

  writeRange(req: WriteRequest): Promise<WriteResult> {
    return this.run(
      "range.write",
      { spreadsheetId: req.spreadsheetId, range: req.range, values: req.values, allowFormulas: req.allowFormulas },
      { spreadsheetId: req.spreadsheetId, cellCount: req.values.length * (req.values[0]?.length ?? 0) },
    );
  }

  appendRows(req: AppendRequest): Promise<AppendResult> {
    return this.run(
      "rows.append",
      { spreadsheetId: req.spreadsheetId, sheet: req.sheet, rows: req.rows, allowFormulas: req.allowFormulas },
      { spreadsheetId: req.spreadsheetId, cellCount: req.rows.length * (req.rows[0]?.length ?? 0) },
    );
  }

  search(req: SearchRequest): Promise<SearchResult> {
    return this.run(
      "search",
      {
        spreadsheetId: req.spreadsheetId,
        query: req.query,
        sheet: req.sheet,
        matchCase: req.matchCase,
        matchEntireCell: req.matchEntireCell,
        limit: req.limit,
      },
      { spreadsheetId: req.spreadsheetId },
    );
  }

  batchUpdate(req: BatchRequest): Promise<BatchResult> {
    return this.run(
      "batch.update",
      { spreadsheetId: req.spreadsheetId, operations: req.operations, allowFormulas: req.allowFormulas },
      { spreadsheetId: req.spreadsheetId },
    );
  }
}
