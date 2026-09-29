import type { Request, RequestHandler, Response, Router } from "express";
import type { ConnectionRegistry } from "../connection/connection-registry.js";
import { parseSpreadsheetLines } from "../connection/setup-bundle.js";
import { HttpError } from "./errors.js";

export type Wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => RequestHandler;

/**
 * The "Thêm Apps Script" flow (DESIGN.md 9.2), shared by the public /account API and the owner's admin API.
 * Every route is scoped to `userIdOf(req)`: a pending connection of somebody else is a 404.
 */
export function mountPendingRoutes(router: Router, registry: ConnectionRegistry, userIdOf: (req: Request) => string, wrap: Wrap): void {
  const pid = (req: Request): string => String(req.params.id ?? "");

  router.post(
    "/pending",
    wrap(async (req, res) => {
      // Wizard (DESIGN.md 12): { wizard: true, spreadsheets: "one link or id per line", write: boolean (default true) }.
      const b = (req.body ?? {}) as Record<string, unknown>;
      const wizard = b.wizard === true ? { spreadsheets: parseSpreadsheetLines(b.spreadsheets), write: b.write !== false } : undefined;
      res.status(201).json({ pending: await registry.startPending(userIdOf(req), wizard) });
    }),
  );

  router.get(
    "/pending/:id",
    wrap((req, res) => {
      const p = registry.getPending(pid(req), userIdOf(req));
      if (!p) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy phiên thêm Apps Script.");
      res.json({ pending: p });
    }),
  );

  router.post(
    "/pending/:id/url",
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json({ pending: await registry.submitUrl(pid(req), userIdOf(req), b.url, b.mode) });
    }),
  );

  router.delete(
    "/pending/:id",
    wrap(async (req, res) => {
      if (!(await registry.cancelPending(pid(req), userIdOf(req)))) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy phiên thêm Apps Script.");
      res.json({ ok: true });
    }),
  );

  /** Personalised Code.gs as copyable text (JSON) ... */
  router.get(
    "/pending/:id/bundle",
    wrap((req, res) => {
      res.set("Cache-Control", "no-store").json({ text: registry.personalizedBundle(pid(req), userIdOf(req)) });
    }),
  );

  /** ... and as a download. */
  router.get(
    "/pending/:id/Code.gs",
    wrap((req, res) => {
      const text = registry.personalizedBundle(pid(req), userIdOf(req));
      res
        .set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": 'attachment; filename="Code.gs"' })
        .type("text/plain; charset=utf-8")
        .send(text);
    }),
  );
}
