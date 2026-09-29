/** Port: everything the business layer needs from a spreadsheet backend. Domain vocabulary only. */

export const GATEWAY_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "REQUEST_EXPIRED",
  "REPLAYED",
  "UNKNOWN_ACTION",
  "PAIRING_NOT_READY",
  "PAIRING_INVALID",
  "SPREADSHEET_NOT_AUTHORIZED",
  "WRITE_NOT_ALLOWED",
  "SHEET_NOT_FOUND",
  "INVALID_RANGE",
  "RANGE_SIZE_MISMATCH",
  "LIMIT_EXCEEDED",
  "FORMULA_NOT_ALLOWED",
  "INVALID_VALUE",
  "INTERNAL",
  "EVAL_DISABLED",
  "EVAL_ERROR",
] as const;

/** DESIGN.md 4.4 codes, plus NOT_CONNECTED which is raised locally and never appears on the wire. */
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number] | "NOT_CONNECTED";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    /** Only EVAL_ERROR carries these: the log lines a script wrote before it threw. */
    public readonly logs?: string[],
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type CellValue = string | number | boolean | null;
export type RenderMode = "FORMATTED" | "UNFORMATTED" | "FORMULA";
export type AccessLevel = "read" | "write";

export interface SpreadsheetInfo {
  id: string;
  name: string;
  alias: string | null;
  access: AccessLevel;
  url: string;
}

export interface SheetInfo {
  sheetId: number;
  name: string;
  index: number;
  rowCount: number;
  columnCount: number;
  lastRow: number;
  lastColumn: number;
  frozenRows: number;
  frozenColumns: number;
  hidden: boolean;
}

export interface SpreadsheetMetadata {
  id: string;
  name: string;
  url: string;
  locale: string;
  timeZone: string;
  sheets: SheetInfo[];
}

export interface PingResult {
  account: string;
  backendVersion: string | null;
  spreadsheetCount: number;
  /** Whether the owner enabled script evaluation; null when the backend does not say. */
  evalEnabled?: boolean | null;
}

export interface ReadRequest {
  spreadsheetId: string;
  range: string;
  render?: RenderMode;
}
export interface ReadResult {
  range: string;
  values: CellValue[][];
}

export interface WriteRequest {
  spreadsheetId: string;
  range: string;
  values: CellValue[][];
  allowFormulas?: boolean;
}
export interface WriteResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface AppendRequest {
  spreadsheetId: string;
  sheet: string;
  rows: CellValue[][];
  allowFormulas?: boolean;
}
export interface AppendResult {
  updatedRange: string;
  appendedRows: number;
}

export interface SearchRequest {
  spreadsheetId: string;
  query: string;
  sheet?: string;
  matchCase?: boolean;
  matchEntireCell?: boolean;
  limit?: number;
}
export interface SearchMatch {
  sheet: string;
  range: string;
  row: number;
  column: number;
  value: CellValue;
}
export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export type BatchOperation =
  | { type: "write"; range: string; values: CellValue[][] }
  | { type: "append"; sheet: string; rows: CellValue[][] }
  | { type: "clear"; range: string };

export interface BatchRequest {
  spreadsheetId: string;
  operations: BatchOperation[];
  allowFormulas?: boolean;
}
export interface BatchResult {
  results: Array<Record<string, unknown>>;
}

export interface SheetsGateway {
  ping(): Promise<PingResult>;
  listSpreadsheets(): Promise<SpreadsheetInfo[]>;
  getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata>;
  readRange(req: ReadRequest): Promise<ReadResult>;
  writeRange(req: WriteRequest): Promise<WriteResult>;
  appendRows(req: AppendRequest): Promise<AppendResult>;
  search(req: SearchRequest): Promise<SearchResult>;
  batchUpdate(req: BatchRequest): Promise<BatchResult>;
}
