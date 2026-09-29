/**
 * Persistence port of StateStore (DESIGN.md 10.1). The store keeps the whole document in memory and asks the backend to
 * persist it after every mutation; the backend never looks inside the document.
 */
export interface StateBackend {
  /** The stored document, or null when nothing has been stored yet. A corrupt document is an error, never null. */
  load(): Promise<unknown | null>;
  /** Persists the whole document. `doc` must be serialised before the first await: the caller goes on mutating it. */
  save(doc: unknown): Promise<void>;
  close(): Promise<void>;
  /** Local file only: keep an untouched copy of the stored document as `<file><suffix>` before a one-way migration. */
  backupOriginal?(suffix: string): Promise<void>;
}
