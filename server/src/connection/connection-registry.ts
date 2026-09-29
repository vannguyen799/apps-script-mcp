import { randomUUID } from "node:crypto";
import { AppsScriptClient } from "../adapters/apps-script/client.js";
import { AppsScriptGateway } from "../adapters/apps-script/gateway.js";
import {
  APPS_SCRIPT_URL_RE,
  PAIRING_POLL_MS,
  PAIRING_TTL_MS,
  attemptPair,
  attemptSetupPair,
  formatPairingCode,
  generatePairingCode,
} from "../adapters/apps-script/pairing.js";
import type { AllowlistResult, PairAttempt } from "../adapters/apps-script/pairing.js";
import { newSecret } from "../adapters/apps-script/signing.js";
import type { FetchLike } from "../adapters/apps-script/transport.js";
import type { EvalResult, ScriptEvaluator } from "../core/script/evaluator.js";
import { isScriptEvaluator } from "../core/script/evaluator.js";
import type { SheetsGateway } from "../core/sheets/gateway.js";
import { GatewayError } from "../core/sheets/gateway.js";
import type { PatService } from "../auth/pat.js";
import { SheetsService } from "../core/sheets/sheets.service.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { PendingConnection, StateStore, StoredConnection } from "../store/state-store.js";
import { randomB64Url } from "../util/crypto.js";
import { personalizeBundle } from "./setup-bundle.js";

/** A pending connection lives 30 min (DESIGN.md 9.2); a pairing code 10 min inside that. */
export const PENDING_TTL_MS = 30 * 60_000;
export const MAX_PENDING_PER_USER = 5;
export const MAX_CONNECTIONS_PER_USER = 20;
const OUTCOME_KEEP_MS = 10 * 60_000;

export const CONNECTION_REMOVED_MESSAGE = "Kết nối Apps Script đã bị xóa, hãy kết nối lại";

export type ConnectionState = "connected" | "error";

export interface ConnectionView {
  id: string;
  userId: string;
  ownerUsername: string | null;
  label: string;
  account: string;
  url: string;
  scriptId: string | null;
  state: ConnectionState;
  message: string | null;
  pairedAt: number;
  lastOkAt: number | null;
  /** Owner's script-evaluation switch as of the last ping; null when unknown. */
  evalEnabled: boolean | null;
}

export type PendingState = "waiting_url" | "waiting_script" | "connected" | "failed" | "expired";

export interface PendingView {
  id: string;
  state: PendingState;
  expiresAt: number;
  /** Personalised Code.gs can be produced (bundle present and valid). */
  setupAvailable: boolean;
  url: string | null;
  mode: "setup" | "code" | null;
  /** XXXX-XXXX, code mode only. */
  code: string | null;
  codeExpiresAt: number | null;
  message: string | null;
  /** Set when state is "connected". */
  connection: ConnectionView | null;
  /** True when the pairing refreshed an existing connection of the same script instead of adding one. */
  updated: boolean;
  /** What the script did with the wizard's spreadsheets; null when there were none or the script is older. */
  allowlist: AllowlistResult | null;
  /** The auto-created PAT (DESIGN.md 12): present in exactly one status response, the first one after pairing. */
  pat: string | null;
}

/** What a tool call runs against: resolved from a connection id, never from tool input. */
export interface ConnectionRuntime {
  service: SheetsService;
  evaluator: ScriptEvaluator;
}

/** Port used by the MCP layer. Returns undefined when the connection is gone or is not the user's. */
export type ResolveConnection = (connectionId: string, userId: string) => ConnectionRuntime | undefined;

interface Outcome {
  userId: string;
  state: "connected" | "failed" | "expired";
  message: string | null;
  connectionId?: string;
  updated?: boolean;
  allowlist?: AllowlistResult | null;
  /** Deleted as soon as it has been returned once. */
  pat?: string;
  at: number;
}

export interface ConnectionRegistryOptions {
  store: StateStore;
  /** Creates the wizard's PAT; without it the wizard just does not create one. */
  pats?: PatService;
  logger?: Logger;
  instanceLabel: string;
  /** The shipped Code.gs with the placeholder line, or null (personalised download hidden). */
  bundle?: string | null;
  /** Current public base URL; the bundle carries it (or "local"). */
  baseUrl?: () => string | undefined;
  fetchImpl?: FetchLike;
  now?: () => number;
  pollIntervalMs?: number;
  healthIntervalMs?: number;
  /** Builds the gateway for a connection; overridable in tests. */
  gatewayFactory?: (conn: StoredConnection) => SheetsGateway;
}

interface Runtime {
  key: string;
  gateway: SheetsGateway;
  service: SheetsService;
}

/**
 * All Apps Script connections of all users (DESIGN.md 9.2): one AppsScriptClient / gateway / SheetsService cache and one
 * health status per connection, plus the pending-connection pairing flow. Everything is addressed by connection id.
 */
export class ConnectionRegistry {
  private readonly store: StateStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly checkedAt = new Map<string, number>();
  private readonly notes = new Map<string, string>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly polling = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: ConnectionRegistryOptions) {
    this.store = opts.store;
    this.log = opts.logger ?? nullLogger;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- lifecycle ----------------------------------------------------------
  start(): void {
    this.pollTimer = setInterval(() => void this.pollOnce().catch(() => {}), this.opts.pollIntervalMs ?? PAIRING_POLL_MS);
    this.pollTimer.unref();
    this.healthTimer = setInterval(() => void this.pingAll().catch(() => {}), this.opts.healthIntervalMs ?? 5 * 60_000);
    this.healthTimer.unref();
    void this.pingAll().catch(() => {});
  }

  stop(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.healthTimer);
  }

  get setupAvailable(): boolean {
    return typeof this.opts.bundle === "string";
  }

  // ---- runtime (per connection) -------------------------------------------
  private runtimeFor(conn: StoredConnection): Runtime {
    const key = `${conn.url}|${conn.instanceId}|${conn.secret}`;
    const cached = this.runtimes.get(conn.id);
    if (cached?.key === key) return cached;
    const gateway =
      this.opts.gatewayFactory?.(conn) ??
      new AppsScriptGateway(
        new AppsScriptClient({ url: conn.url, instanceId: conn.instanceId, secret: conn.secret, fetchImpl: this.opts.fetchImpl, logger: this.log, now: this.now }),
        this.log,
      );
    const rt: Runtime = { key, gateway, service: new SheetsService(gateway) };
    this.runtimes.set(conn.id, rt);
    return rt;
  }

  /** The only way a tool reaches Apps Script. The connection must exist and belong to `userId`. */
  resolve: ResolveConnection = (connectionId, userId) => {
    const conn = this.store.state.connections[connectionId];
    if (!conn) {
      this.runtimes.delete(connectionId);
      return undefined;
    }
    if (conn.userId !== userId) return undefined;
    const rt = this.runtimeFor(conn);
    const evaluator: ScriptEvaluator = {
      evaluate: async (code: string, args?: unknown): Promise<EvalResult> => {
        if (!isScriptEvaluator(rt.gateway)) throw new GatewayError("UNKNOWN_ACTION", "This backend cannot run scripts.");
        return rt.gateway.evaluate(code, args);
      },
    };
    return { service: rt.service, evaluator };
  };

  /** Direct gateway access for the owner's connection listing tools ("test" and spreadsheet list). */
  gatewayFor(connectionId: string): SheetsGateway | undefined {
    const conn = this.store.state.connections[connectionId];
    return conn ? this.runtimeFor(conn).gateway : undefined;
  }

  // ---- views --------------------------------------------------------------
  private view(c: StoredConnection): ConnectionView {
    return {
      id: c.id,
      userId: c.userId,
      ownerUsername: this.store.state.users[c.userId]?.username ?? null,
      label: c.label,
      account: c.account,
      url: c.url,
      scriptId: c.scriptId,
      state: c.lastError ? "error" : "connected",
      message: c.lastError,
      pairedAt: c.pairedAt,
      lastOkAt: c.lastOkAt,
      evalEnabled: c.evalEnabled,
    };
  }

  get(id: string): StoredConnection | undefined {
    return this.store.state.connections[id];
  }

  getView(id: string): ConnectionView | undefined {
    const c = this.get(id);
    return c ? this.view(c) : undefined;
  }

  listFor(userId: string): ConnectionView[] {
    return Object.values(this.store.state.connections)
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((c) => this.view(c));
  }

  listAll(): ConnectionView[] {
    return Object.values(this.store.state.connections)
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((c) => this.view(c));
  }

  // ---- health ---------------------------------------------------------------
  async ping(connectionId: string): Promise<ConnectionView> {
    const conn = this.store.state.connections[connectionId];
    if (!conn) throw new GatewayError("NOT_CONNECTED", CONNECTION_REMOVED_MESSAGE);
    const gw = this.runtimeFor(conn).gateway;
    const t0 = this.now();
    try {
      const r = await gw.ping();
      await this.store.update((s) => {
        const c = s.connections[connectionId];
        if (!c) return;
        c.lastOkAt = this.now();
        c.lastError = null;
        c.evalEnabled = r.evalEnabled ?? null;
        c.account = r.account;
        const sid = r.scriptId ?? null;
        if (sid && !c.scriptId && !Object.values(s.connections).some((o) => o.userId === c.userId && o.scriptId === sid)) c.scriptId = sid;
      });
    } catch (e) {
      const message = e instanceof GatewayError ? `${e.code}: ${e.message}` : "Ping thất bại.";
      await this.store.update((s) => {
        const c = s.connections[connectionId];
        if (!c) return;
        c.lastError = message;
        c.evalEnabled = null;
      });
      this.log.warn("health_ping_failed", { resultCode: e instanceof GatewayError ? e.code : "INTERNAL", durationMs: this.now() - t0 });
    }
    this.checkedAt.set(connectionId, this.now());
    const after = this.getView(connectionId);
    if (!after) throw new GatewayError("NOT_CONNECTED", CONNECTION_REMOVED_MESSAGE);
    return after;
  }

  async pingAll(): Promise<void> {
    for (const id of Object.keys(this.store.state.connections)) await this.ping(id).catch(() => {});
  }

  // ---- management -------------------------------------------------------------
  /** `actorUserId` null means the owner acting from /account (may remove anyone's). Returns false when not found / not theirs. */
  async remove(connectionId: string, actorUserId: string | null): Promise<boolean> {
    const c = this.store.state.connections[connectionId];
    if (!c || (actorUserId !== null && c.userId !== actorUserId)) return false;
    await this.store.update((s) => {
      delete s.connections[connectionId];
      for (const u of Object.values(s.users)) if (u.lastConnectionId === connectionId) u.lastConnectionId = null;
    });
    this.runtimes.delete(connectionId);
    this.checkedAt.delete(connectionId);
    this.log.info("connection_removed");
    return true;
  }

  async rename(connectionId: string, userId: string, label: unknown): Promise<ConnectionView | undefined> {
    const clean = typeof label === "string" ? label.trim().slice(0, 64) : "";
    if (!clean) throw new GatewayError("BAD_REQUEST", "Nhãn không được để trống.");
    if (this.store.state.connections[connectionId]?.userId !== userId) return undefined;
    await this.store.update((s) => {
      const c = s.connections[connectionId];
      if (c && c.userId === userId) c.label = clean;
    });
    return this.getView(connectionId);
  }

  // ---- pending connections (DESIGN.md 9.2) -----------------------------------------
  private prune(): void {
    const t = this.now();
    for (const [id, o] of this.outcomes) if (t - o.at > OUTCOME_KEEP_MS) this.outcomes.delete(id);
  }

  /** `wizard` (DESIGN.md 12): the spreadsheets for the personalised Code.gs; the first new pairing then auto-creates a PAT. */
  async startPending(userId: string, wizard?: { spreadsheets: string[]; write: boolean }): Promise<PendingView> {
    this.prune();
    const t = this.now();
    const rec: PendingConnection = {
      id: randomUUID(),
      userId,
      instanceId: randomUUID(),
      secret: newSecret(),
      setupToken: randomB64Url(32),
      expiresAt: t + PENDING_TTL_MS,
      ...(wizard ? { wizard: true, spreadsheets: wizard.spreadsheets.map((id) => ({ id, access: wizard.write ? ("write" as const) : ("read" as const) })) } : {}),
    };
    await this.store.update((s) => {
      for (const [id, p] of Object.entries(s.pendingConnections)) if (p.expiresAt <= t) delete s.pendingConnections[id];
      const mine = Object.values(s.pendingConnections)
        .filter((p) => p.userId === userId)
        .sort((a, b) => a.expiresAt - b.expiresAt);
      for (const p of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) delete s.pendingConnections[p.id];
      s.pendingConnections[rec.id] = rec;
    });
    this.log.info("pending_connection_started");
    return this.pendingView(rec);
  }

  private livePending(id: string, userId: string): PendingConnection | undefined {
    const p = this.store.state.pendingConnections[id];
    return p && p.userId === userId && p.expiresAt > this.now() ? p : undefined;
  }

  private pendingView(p: PendingConnection): PendingView {
    return {
      id: p.id,
      state: p.url ? "waiting_script" : "waiting_url",
      expiresAt: p.expiresAt,
      setupAvailable: this.setupAvailable,
      url: p.url ?? null,
      mode: p.mode ?? null,
      code: p.code ? formatPairingCode(p.code) : null,
      codeExpiresAt: p.codeExpiresAt ?? null,
      message: this.notes.get(p.id) ?? null,
      connection: null,
      updated: false,
      allowlist: null,
      pat: null,
    };
  }

  /** The live pending, or its final outcome (connected / failed / expired) for a few minutes after. */
  getPending(id: string, userId: string): PendingView | undefined {
    const p = this.livePending(id, userId);
    if (p) return this.pendingView(p);
    const o = this.outcomes.get(id);
    if (o && o.userId === userId) {
      return {
        id,
        state: o.state,
        expiresAt: 0,
        setupAvailable: this.setupAvailable,
        url: null,
        mode: null,
        code: null,
        codeExpiresAt: null,
        message: o.message,
        connection: o.connectionId ? (this.getView(o.connectionId) ?? null) : null,
        updated: o.updated ?? false,
        allowlist: o.allowlist ?? null,
        pat: this.takePat(o),
      };
    }
    if (this.store.state.pendingConnections[id]?.userId === userId) return { ...this.pendingView(this.store.state.pendingConnections[id]!), state: "expired", message: "Phiên thêm Apps Script đã hết hạn." };
    return undefined;
  }

  private takePat(o: Outcome): string | null {
    const pat = o.pat ?? null;
    delete o.pat;
    return pat;
  }

  async cancelPending(id: string, userId: string): Promise<boolean> {
    const p = this.store.state.pendingConnections[id];
    if (!p || p.userId !== userId) return false;
    await this.store.update((s) => {
      delete s.pendingConnections[id];
    });
    this.notes.delete(id);
    return true;
  }

  /**
   * The user pasted the web app URL. mode "setup": the script was installed from the personalised Code.gs, the server
   * sends setup pair requests. mode "code": an already-installed script, the server shows an 8-char code.
   */
  async submitUrl(id: string, userId: string, url: unknown, mode: unknown): Promise<PendingView> {
    const u = typeof url === "string" ? url.trim() : "";
    if (!APPS_SCRIPT_URL_RE.test(u)) throw new GatewayError("BAD_REQUEST", "URL phải có dạng https://script.google.com/macros/s/<id>/exec");
    if (mode !== "setup" && mode !== "code") throw new GatewayError("BAD_REQUEST", "mode must be setup or code");
    if (mode === "setup" && !this.setupAvailable) throw new GatewayError("BAD_REQUEST", "Bản Code.gs cá nhân hóa không có sẵn trên server này.");
    const p = this.livePending(id, userId);
    if (!p) throw new GatewayError("BAD_REQUEST", "Phiên thêm Apps Script không tồn tại hoặc đã hết hạn.");
    const t = this.now();
    await this.store.update((s) => {
      const cur = s.pendingConnections[id];
      if (!cur) return;
      cur.url = u;
      cur.mode = mode;
      if (mode === "code") {
        cur.code = generatePairingCode();
        cur.codeExpiresAt = Math.min(cur.expiresAt, t + PAIRING_TTL_MS);
      } else {
        delete cur.code;
        delete cur.codeExpiresAt;
      }
    });
    this.notes.delete(id);
    this.log.info("pending_connection_url_set", { reason: mode });
    return this.getPending(id, userId)!;
  }

  /** The personalised Code.gs for a live pending connection; throws when the bundle is missing or unusable (fail closed). */
  personalizedBundle(id: string, userId: string): string {
    const bundle = this.opts.bundle;
    const p = this.livePending(id, userId);
    if (!p) throw new GatewayError("BAD_REQUEST", "Phiên thêm Apps Script không tồn tại hoặc đã hết hạn.");
    if (typeof bundle !== "string") throw new GatewayError("BAD_REQUEST", "Bản Code.gs cá nhân hóa không có sẵn trên server này.");
    try {
      return personalizeBundle(bundle, { server: this.opts.baseUrl?.() ?? "local", token: p.setupToken, expiresAt: p.expiresAt, spreadsheets: p.spreadsheets });
    } catch {
      throw new GatewayError("INTERNAL", "Bản Code.gs trên server không hợp lệ.");
    }
  }

  /** One polling round over every pending connection that has a URL; called every 4 s. */
  async pollOnce(): Promise<void> {
    const t = this.now();
    for (const p of Object.values(this.store.state.pendingConnections)) {
      if (p.expiresAt <= t) {
        await this.store.update((s) => {
          delete s.pendingConnections[p.id];
        });
        this.notes.delete(p.id);
        this.outcomes.set(p.id, { userId: p.userId, state: "expired", message: "Phiên thêm Apps Script đã hết hạn.", at: t });
        this.log.info("pending_connection_expired");
        continue;
      }
      if (!p.url || !p.mode || this.polling.has(p.id)) continue;
      if (p.mode === "code" && p.codeExpiresAt !== undefined && p.codeExpiresAt <= t) {
        await this.store.update((s) => {
          const cur = s.pendingConnections[p.id];
          if (cur) {
            delete cur.url;
            delete cur.mode;
            delete cur.code;
            delete cur.codeExpiresAt;
          }
        });
        this.notes.set(p.id, "Mã ghép cặp đã hết hạn. Hãy nhập lại URL để tạo mã mới.");
        continue;
      }
      this.polling.add(p.id);
      try {
        await this.pollPending(p);
      } finally {
        this.polling.delete(p.id);
      }
    }
  }

  private async pollPending(p: PendingConnection): Promise<void> {
    const common = {
      url: p.url!,
      instanceId: p.instanceId,
      instanceLabel: this.opts.instanceLabel,
      secret: p.secret,
      fetchImpl: this.opts.fetchImpl,
      now: this.now,
    };
    const r: PairAttempt = p.mode === "setup" ? await attemptSetupPair({ ...common, token: p.setupToken }) : await attemptPair({ ...common, code: p.code ?? "" });
    // The pending may have been cancelled or replaced while the request was in flight.
    const cur = this.store.state.pendingConnections[p.id];
    if (!cur || cur.secret !== p.secret || cur.url !== p.url) return;
    switch (r.status) {
      case "paired":
        await this.completePairing(cur, r);
        break;
      case "not_ready":
        this.notes.delete(p.id);
        break;
      case "invalid":
        if (p.mode === "setup") {
          await this.fail(cur, "Apps Script từ chối token cài đặt (đã dùng hoặc không khớp). Hãy tạo lại bản Code.gs mới.");
        } else {
          this.notes.set(p.id, "Mã đã nhập trong trang Apps Script không khớp.");
        }
        break;
      case "bad_proof":
        await this.fail(cur, "Apps Script trả về proof không hợp lệ; secret đã bị hủy. Kiểm tra URL và thử lại.");
        this.log.warn("pairing_bad_proof");
        break;
      case "clock_skew":
        this.notes.set(p.id, "Đồng hồ máy chủ lệch so với Google quá 5 phút. Hãy chỉnh lại giờ của máy chạy Docker.");
        break;
      case "limit":
        await this.fail(cur, "Script đã đạt 20 kết nối, hãy gỡ bớt trên trang Apps Script.");
        break;
      case "failed":
        this.notes.set(p.id, r.message);
        break;
    }
  }

  private async fail(p: PendingConnection, message: string): Promise<void> {
    await this.store.update((s) => {
      delete s.pendingConnections[p.id];
    });
    this.notes.delete(p.id);
    this.outcomes.set(p.id, { userId: p.userId, state: "failed", message, at: this.now() });
  }

  /**
   * DESIGN.md 9.2: when the same user already has a connection with this scriptId, that connection is updated
   * (url, instanceId, secret, account, pairedAt) and keeps its id, so grants, tokens and PATs keep working.
   * Uniqueness is (userId, scriptId) only; the email is never a key.
   */
  private async completePairing(p: PendingConnection, r: Extract<PairAttempt, { status: "paired" }>): Promise<void> {
    const t = this.now();
    let connectionId = "";
    let updated = false;
    let overLimit = false;
    await this.store.update((s) => {
      delete s.pendingConnections[p.id];
      const existing = r.scriptId ? Object.values(s.connections).find((c) => c.userId === p.userId && c.scriptId === r.scriptId) : undefined;
      if (existing) {
        existing.url = p.url!;
        existing.instanceId = p.instanceId;
        existing.secret = p.secret;
        existing.account = r.account;
        existing.pairedAt = t;
        existing.lastOkAt = t;
        existing.lastError = null;
        connectionId = existing.id;
        updated = true;
        return;
      }
      if (Object.values(s.connections).filter((c) => c.userId === p.userId).length >= MAX_CONNECTIONS_PER_USER) {
        overLimit = true;
        return;
      }
      const id = randomUUID();
      s.connections[id] = {
        id,
        userId: p.userId,
        label: (r.account + (r.scriptName ? ` · ${r.scriptName}` : "")).slice(0, 64),
        url: p.url!,
        instanceId: p.instanceId,
        secret: p.secret,
        account: r.account,
        scriptId: r.scriptId,
        pairedAt: t,
        lastOkAt: t,
        lastError: null,
        evalEnabled: null,
      };
      connectionId = id;
    });
    this.notes.delete(p.id);
    if (overLimit) {
      this.outcomes.set(p.id, { userId: p.userId, state: "failed", message: `Bạn đã có tối đa ${MAX_CONNECTIONS_PER_USER} kết nối. Hãy xóa bớt trước.`, at: t });
      return;
    }
    this.runtimes.delete(connectionId); // credentials may have changed
    // Only a brand-new connection gets the wizard's PAT: re-pairing a script must not mint another token.
    let pat: string | undefined;
    if (p.wizard && !updated && this.opts.pats) {
      try {
        pat = (await this.opts.pats.create(p.userId, connectionId, "Claude Code (tự tạo)", ["sheets.read", "sheets.write"])).token;
      } catch {
        this.log.warn("wizard_pat_failed");
      }
    }
    this.outcomes.set(p.id, {
      userId: p.userId,
      state: "connected",
      message: updated ? "Script này đã được kết nối trước đó, đã cập nhật." : null,
      connectionId,
      updated,
      allowlist: r.allowlist,
      pat,
      at: t,
    });
    this.log.info("pairing_completed", { reason: updated ? "updated" : "created" });
  }
}
