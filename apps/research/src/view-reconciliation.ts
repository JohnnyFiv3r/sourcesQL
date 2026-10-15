import type { ResearchView } from "./schema.js";

type ReconciliationOptions = {
  current: () => ResearchView | undefined;
  navigationVersion: () => number;
  editing: () => boolean;
  read: (snapshotId: string, offset: number) => Promise<ResearchView>;
  accept: (view: ResearchView) => void;
  onError: (cause: unknown) => void;
};

/** Reopen durable state once; a host's cached tool result is only a bootstrap. */
export class HostedViewReconciliation {
  private received = false;
  private connected = false;
  private attempted = false;
  private disposed = false;
  private epoch = 0;

  constructor(private readonly options: ReconciliationOptions) {}

  hostConnected(canRead: boolean) {
    this.connected = canRead;
    this.reconcile();
  }

  hostResult(view: ResearchView) {
    // A repeated cached result must not undo corrections, paging or navigation.
    if (this.received || this.disposed) return false;
    this.received = true;
    const accepted = !this.options.current();
    if (accepted) this.options.accept(view);
    this.reconcile();
    return accepted;
  }

  invalidate() {
    this.epoch++;
  }

  get version() {
    return this.epoch;
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
  }

  private reconcile() {
    const previous = this.options.current();
    if (
      !this.connected ||
      !this.received ||
      this.attempted ||
      this.disposed ||
      !previous
    )
      return;
    this.attempted = true;
    if (this.options.editing()) return;
    const epoch = this.epoch;
    const navigation = this.options.navigationVersion();
    const offset = previous.preview?.offset ?? 0;
    const isCurrent = () =>
      !this.disposed &&
      epoch === this.epoch &&
      navigation === this.options.navigationVersion() &&
      previous === this.options.current() &&
      !this.options.editing();
    void this.options.read(previous.snapshot.id, offset).then(
      (next) => {
        if (
          isCurrent() &&
          next.snapshot.id === previous.snapshot.id &&
          next.revision >= previous.revision &&
          (next.preview?.offset ?? 0) === offset
        )
          this.options.accept(next);
      },
      (cause) => {
        if (isCurrent()) this.options.onError(cause);
      },
    );
  }
}
