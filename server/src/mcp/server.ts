import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SheetsService } from "../core/sheets/sheets.service.js";
import type { Logger } from "../log.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "gsheets-mcp";
export const SERVER_VERSION = "0.1.0";

/** Stateless mode: build a fresh McpServer for every request. */
export function createMcpServer(service: SheetsService, logger?: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read and edit Google Sheets the owner has authorized. Start with list_spreadsheets. Ranges must always include the sheet name (e.g. Sheet1!A1:F100). Writes overwrite data; formulas are rejected unless allow_formulas is true.",
    },
  );
  registerTools(server, { service, logger });
  return server;
}
