import { AppsScriptClient } from "../adapters/apps-script/client.js";
import { AppsScriptGateway } from "../adapters/apps-script/gateway.js";
import {
  APPS_SCRIPT_URL_RE,
  PAIRING_POLL_MS,
  PAIRING_TTL_MS,
  attemptPair,
  formatPairingCode,
  generatePairingCode,
} from "../adapters/apps-script/pairing.js";
import { newSecret } from "../adapters/apps-script/signing.js";
import type { FetchLike } from "../adapters/apps-script/transport.js";
import type {
  AppendRequest,
  AppendResult,
  BatchRequest,
  BatchResult,

  ReadRequest,
  ReadResult,
  SearchRequest,
  SearchResult,
  SheetsGateway,
  SpreadsheetInfo,
  SpreadsheetMetadata,
  WriteRequest,
  WriteResult,
} from "../core/sheets/gateway.js";
import { GatewayError } from "../core/sheets/gateway.js";
import type { Logger } from "../log.js";
import { nullLogger } from "../log.js";
import type { AppsScriptLink } from "../store/state-store.js";
import { StateStore } from "../store/state-store.js";

export type ConnectionState = "not_connected" | "pairing_pending" | "connected" | "error";

export interface ConnectionStatus {
  state: ConnectionState;
  message: string | null;
  account: string | null;
  pairedAt: number | null;
  appsScriptUrl: string | null;
  lastCheckedAt: number | null;
  pairing: { code: string; expiresAt: number; url: string } | null;
}

export interface ConnectionManagerOptions {
  store: StateStore;
  logger?: Logger;
  instanceLabel: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  pollIntervalMs?: number;
  healthIntervalMs?: number;
  /** Builds the gateway for a link; overridable in tests. */
  gatewayFactory?: (link: AppsScriptLink, instanceId: string) => SheetsGateway;
}

/** Owns the Apps Script link lifecycle: pairing, health pings, unpair. Exposes a gateway that follows the current link. */
export class ConnectionManager {
  private readonly store: StateStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private errorMessage: string | null = null;
  private notice: string | null = null;
  private lastCheckedAt: number | null = null;
  private polling = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private readonly listeners: Array<() => void> = [];
  private cachedGateway: { key: string; gw: SheetsGateway } | null = null;

  constructor(private readonly opts: ConnectionManagerOptions) {
    this.store = opts.store;
    this.log = opts.logger ?? nullLogger;
    this.now = opts.now ?? Date.now;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    this.cachedGateway = null;
    for (const l of this.listeners) l();
  }

  start(): void {
    this.pollTimer = setInterval(() => void this.pollOnce(), this.opts.pollIntervalMs ?? PAIRING_POLL_MS);
    this.pollTimer.unref();
    this.healthTimer = setInterval(() => void this.ping().catch(() => {}), this.opts.healthIntervalMs ?? 5 * 60_000);
    this.healthTimer.unref();
    if (this.store.state.link) void this.ping().catch(() => {});
  }

  stop(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.healthTimer);
  }

  private pendingActive() {
    const p = this.store.state.pending;
    return p && p.expiresAt > this.now() ? p : null;
  }

  status(): ConnectionStatus {
    const s = this.store.state;
    const pending = this.pendingActive();
    let state: ConnectionState;
    let message: string | null = null;
    if (pending) {
      state = "pairing_pending";
      message = this.errorMessage;
    } else if (this.errorMessage) {
      state = "error";
      message = this.errorMessage;
    } else if (s.link) {
      state = "connected";
    } else {
      state = "not_connected";
      message = this.notice;
    }
    return {
      state,
      message,
      account: s.link?.account ?? null,
      pairedAt: s.link?.pairedAt ?? null,
      appsScriptUrl: s.link?.url ?? pending?.url ?? null,
      lastCheckedAt: this.lastCheckedAt,
      pairing: pending ? { code: formatPairingCode(pending.code), expiresAt: pending.expiresAt, url: pending.url } : null,
    };
  }

  async startPairing(url: string): Promise<ConnectionStatus> {
    const u = typeof url === "string" ? url.trim() : "";
    if (!APPS_SCRIPT_URL_RE.test(u)) {
      throw new GatewayError("BAD_REQUEST", "The URL must look like https://script.google.com/macros/s/<id>/exec");
    }
    const pending = { url: u, code: generatePairingCode(), secret: newSecret(), expiresAt: this.now() + PAIRING_TTL_MS };
    this.errorMessage = null;
    this.notice = null;
    await this.store.update((s) => {
      s.pending = pending;
    });
    this.log.info("pairing_started");
    return this.status();
  }

  async cancelPairing(): Promise<ConnectionStatus> {
    await this.store.update((s) => {
      s.pending = null;
    });
    this.errorMessage = null;
    return this.status();
  }

  /** One pairing poll; called every 4 s by the timer. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    const p = this.store.state.pending;
    if (!p) return;
    if (p.expiresAt <= this.now()) {
      await this.store.update((s) => {
        s.pending = null;
      });
      this.notice = "Mã pairing đã hết hạn. Hãy tạo mã mới.";
      this.errorMessage = null;
      this.log.info("pairing_expired");
      return;
    }
    this.polling = true;
    try {
      const r = await attemptPair({
        url: p.url,
        instanceId: this.store.state.instanceId,
        instanceLabel: this.opts.instanceLabel,
        code: p.code,
        secret: p.secret,
        fetchImpl: this.opts.fetchImpl,
        now: this.now,
      });
      switch (r.status) {
        case "paired": {
          const link: AppsScriptLink = { url: p.url, secret: p.secret, account: r.account, pairedAt: this.now() };
          await this.store.update((s) => {
            s.link = link;
            s.pending = null;
          });
          this.errorMessage = null;
          this.notice = null;
          this.lastCheckedAt = this.now();
          this.changed();
          this.log.info("pairing_completed");
          break;
        }
        case "bad_proof":
          await this.store.update((s) => {
            s.pending = null; // the fresh secret is discarded with it
          });
          this.errorMessage = "Apps Script trả về proof không hợp lệ; secret đã bị hủy. Kiểm tra URL và thử lại.";
          this.log.warn("pairing_bad_proof");
          break;
        case "invalid":
          this.errorMessage = "Mã đã nhập trong trang Apps Script không khớp.";
          break;
        case "failed":
          this.errorMessage = r.message;
          break;
        case "not_ready":
          this.errorMessage = null;
          break;
      }
    } finally {
      this.polling = false;
    }
  }

  async ping(): Promise<ConnectionStatus> {
    if (!this.store.state.link) throw new GatewayError("NOT_CONNECTED", "Chưa kết nối với Apps Script.");
    try {
      const r = await this.gateway.ping();
      this.errorMessage = null;
      this.lastCheckedAt = this.now();
      const link = this.store.state.link;
      if (link && link.account !== r.account) {
        await this.store.update((s) => {
          if (s.link) s.link.account = r.account;
        });
      }
    } catch (e) {
      this.lastCheckedAt = this.now();
      this.errorMessage = e instanceof GatewayError ? `${e.code}: ${e.message}` : "Ping thất bại.";
      this.log.warn("health_ping_failed", { resultCode: e instanceof GatewayError ? e.code : "INTERNAL" });
    }
    return this.status();
  }


  /** Forgets the local link. The Apps Script side must be unpaired on its own admin page. */
  async unpair(): Promise<ConnectionStatus> {
    await this.store.update((s) => {
      s.link = null;
      s.pending = null;
    });
    this.errorMessage = null;
    this.notice = null;
    this.lastCheckedAt = null;
    this.changed();
    this.log.info("unpaired");
    return this.status();
  }

  private currentGateway(): SheetsGateway {
    const link = this.store.state.link;
    if (!link) throw new GatewayError("NOT_CONNECTED", "Not connected to Apps Script. The administrator must pair it in the admin UI first.");
    const key = `${link.url}|${link.secret}`;
    if (this.cachedGateway?.key === key) return this.cachedGateway.gw;
    const instanceId = this.store.state.instanceId;
    const gw =
      this.opts.gatewayFactory?.(link, instanceId) ??
      new AppsScriptGateway(
        new AppsScriptClient({ url: link.url, instanceId, secret: link.secret, fetchImpl: this.opts.fetchImpl, logger: this.log, now: this.now }),
        this.log,
      );
    this.cachedGateway = { key, gw };
    return gw;
  }

  /** A SheetsGateway that always targets the current link (or fails with NOT_CONNECTED). */
  readonly gateway: SheetsGateway = {
    ping: async () => this.currentGateway().ping(),
    listSpreadsheets: async (): Promise<SpreadsheetInfo[]> => this.currentGateway().listSpreadsheets(),
    getMetadata: async (id: string): Promise<SpreadsheetMetadata> => this.currentGateway().getMetadata(id),
    readRange: async (r: ReadRequest): Promise<ReadResult> => this.currentGateway().readRange(r),
    writeRange: async (r: WriteRequest): Promise<WriteResult> => this.currentGateway().writeRange(r),
    appendRows: async (r: AppendRequest): Promise<AppendResult> => this.currentGateway().appendRows(r),
    search: async (r: SearchRequest): Promise<SearchResult> => this.currentGateway().search(r),
    batchUpdate: async (r: BatchRequest): Promise<BatchResult> => this.currentGateway().batchUpdate(r),
  };
}
