import type { StateStore } from "../store/state-store.js";
import { normalizeBaseUrl } from "../util/base-url.js";

export type BaseUrlSource = "env" | "tunnel" | "ui" | null;

/**
 * The issuer / resource base (DESIGN.md 11): PUBLIC_BASE_URL (env, wins and locks the setting) > the URL reported by the
 * built-in tunnel (runtime only, never persisted) > the value saved in the admin UI.
 */
export class PublicBaseUrl {
  constructor(
    private readonly envValue: string | undefined,
    private readonly store: StateStore,
  ) {}

  private tunnelUrl: string | undefined;

  setTunnelUrl(url: string | undefined): void {
    this.tunnelUrl = url;
  }

  get(): string | undefined {
    return this.envValue ?? this.tunnelUrl ?? this.store.state.publicBaseUrl ?? undefined;
  }

  source(): BaseUrlSource {
    if (this.envValue) return "env";
    if (this.tunnelUrl) return "tunnel";
    return this.store.state.publicBaseUrl ? "ui" : null;
  }

  get editable(): boolean {
    return !this.envValue;
  }

  mcpEndpoint(): string | null {
    const b = this.get();
    return b ? `${b}/mcp` : null;
  }

  /** Throws when locked by env or when the URL is unacceptable. Pass null/"" to clear. */
  async set(value: string | null): Promise<void> {
    if (this.envValue) throw new Error("PUBLIC_BASE_URL is set in the environment and cannot be changed here.");
    let normalized: string | null = null;
    if (value !== null && value.trim() !== "") {
      normalized = normalizeBaseUrl(value);
      if (!normalized) throw new Error("Base URL must be an https origin such as https://mcp.example.com (http allowed only for localhost), with no path.");
    }
    await this.store.update((s) => {
      s.publicBaseUrl = normalized;
    });
  }
}
