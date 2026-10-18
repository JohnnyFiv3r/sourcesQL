import { id, type ResearchView } from "./schema.js";

export const SAVED_TABLE_LOAD_ERROR =
  "This saved table could not be loaded. Try loading it again, or reopen the same table from the conversation. Your research has not changed.";
export const SAVED_TABLE_TARGET_MISSING =
  "The host did not identify this saved table. Reopen the table from the conversation to continue.";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalId(value: unknown): string | undefined {
  const checked = id.safeParse(value);
  return checked.success ? checked.data : undefined;
}

/** Failed bootstrap recovery can reread only the table this widget was opening. */
export class SavedTableRecovery {
  private target?: string;
  private explicitTarget = false;
  private failed = false;
  private retried = false;
  private accepted = false;

  get snapshotId() {
    return this.target;
  }

  get hasAccepted() {
    return this.accepted;
  }

  captureInput(value: unknown) {
    if (this.accepted) return;
    const input = record(value);
    const target =
      canonicalId(input.snapshot_id) ??
      canonicalId(record(input.result_ref).snapshot_id) ??
      canonicalId(record(input.snapshot).id);
    if (target) {
      this.target = target;
      this.explicitTarget = true;
    }
  }

  captureResult(value: unknown) {
    if (this.accepted || this.explicitTarget || this.target) return;
    const snapshot = record(record(record(value).structuredContent).snapshot);
    const target = canonicalId(snapshot.id);
    if (target) this.target = target;
  }

  assertTarget(view: ResearchView) {
    if (this.target && view.snapshot.id !== this.target)
      throw new Error(SAVED_TABLE_LOAD_ERROR);
  }

  markFailed() {
    this.failed = true;
  }

  markAccepted() {
    this.accepted = true;
  }

  async readSaved(
    read: (snapshotId: string) => Promise<ResearchView>,
  ): Promise<ResearchView> {
    const target = this.target;
    if (!target) throw new Error(SAVED_TABLE_TARGET_MISSING);
    const view = await read(target);
    if (view.snapshot.id !== target || this.target !== target)
      throw new Error(SAVED_TABLE_LOAD_ERROR);
    return view;
  }

  async retry(
    read: (snapshotId: string) => Promise<ResearchView>,
  ): Promise<ResearchView | undefined> {
    if (!this.failed || !this.target || this.retried || this.accepted) return;
    this.retried = true;
    return this.readSaved(read);
  }
}
