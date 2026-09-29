import { chmod, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { StateBackend } from "./backend.js";

/** DATA_DIR/state.json, written atomically (tmp + rename) at mode 0600. */
export class LocalStateBackend implements StateBackend {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, "state.json");
  }

  async load(): Promise<unknown | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    // A corrupt file is a hard error: silently resetting would drop credentials.
    return JSON.parse(raw) as unknown;
  }

  async save(doc: unknown): Promise<void> {
    const json = JSON.stringify(doc);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await chmod(tmp, 0o600);
      await rename(tmp, this.filePath);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async backupOriginal(suffix: string): Promise<void> {
    const backup = `${this.filePath}${suffix}`;
    await copyFile(this.filePath, backup);
    await chmod(backup, 0o600);
  }

  async close(): Promise<void> {}
}
