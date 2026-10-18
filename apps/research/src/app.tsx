import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { version } from "../package.json";
import { flushSync } from "react-dom";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  Search,
  ArrowUpDown,
  ExternalLink,
  Download,
  Upload,
  RefreshCw,
  PencilLine,
  ArrowRight,
  Check,
  X,
  Database,
  Expand,
  MoreHorizontal,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  ListTree,
  ListChecks,
  FileText,
} from "lucide-react";
import { Button, Input, Textarea, GrowingTextarea, Select } from "./ui.js";
import {
  displayValue,
  effectiveValue,
  snapshotSchema,
  sourcesForViewSelection,
  cellDiagnosticSummary,
  researchGapSummary,
  type ResearchView,
  type Row,
  type ResearchRequestSummary,
} from "./schema.js";
import { correctionKind, parseCorrection } from "./corrections.js";
import { agentMessenger, chatGPTMessaging } from "./agent-messaging.js";
import { CONNECTION_RECOVERY, missingHostTool } from "./connection-errors.js";
import {
  researchLinks,
  researchForSelection,
  researchScopeLabel,
} from "./research-links.js";
import "./styles.css";
import { FeedbackToast } from "./feedback-toast.js";
import { ResearchStatusOverlay } from "./research-status-overlay.js";
import { UsageNoticeOverlay } from "./usage-notice-overlay.js";
import type { UsageNotice } from "./usage.js";
import { ResearchTreePanel } from "./research-tree-panel.js";
import { ResearchJobStatusPanel } from "./job-status-panel.js";
import {
  researchJobViewSchema,
  researchJobView as parseJobReceipt,
  type ResearchJobView,
} from "./job-view.js";
import "./job-status-panel.css";
import { HostedViewReconciliation } from "./view-reconciliation.js";
import { inlineHeightLimitFor } from "./host-sizing.js";
import {
  SAVED_TABLE_LOAD_ERROR,
  SAVED_TABLE_TARGET_MISSING,
  SavedTableRecovery,
} from "./saved-table-recovery.js";
import { decodeResearchView } from "./view-wire.js";
import { QueryFeedbackPanel } from "./query-feedback-panel.js";
import "./query-feedback-panel.css";
import { readNavigation } from "./navigation-read.js";
import {
  UpdateReviewPanel,
  CellUpdateProposal,
  cellUpdateProposals,
  updateReviewReadiness,
  manualUpdateAvailability,
  manualUpdateArguments,
} from "./update-review-panel.js";
import type { ResearchCheckpoint } from "../server/checkpoints.js";
import {
  formatSourceUrl,
  presentationColumns,
  nextTableSort,
  sourceLinksForValue,
} from "./presentation.js";

const MAX_PAGE_SIZE = 25;
const app = new App(
  { name: "sourcesQL research", version },
  {},
  { autoResize: false },
);
function dismissUsageNotice(notice: UsageNotice) {
  if (!/^[a-f0-9]{64}$/.test(notice.id)) return;
  void app
    .callServerTool({
      name: "research_dismiss_usage_notice",
      arguments: { notice_id: notice.id },
    })
    .catch(() => {});
}
function extractView(result: CallToolResult): ResearchView {
  if (result.isError)
    throw new Error(
      result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  return decodeResearchView(result.structuredContent);
}
async function readSavedResearch(snapshotId: string): Promise<ResearchView> {
  try {
    return extractView(
      await app.callServerTool({
        name: "research_status",
        arguments: { snapshot_id: snapshotId },
      }),
    );
  } catch {
    throw new Error(SAVED_TABLE_LOAD_ERROR);
  }
}
function needsReview(row: Row): boolean {
  return /unverified|failed|unavailable|conflict/i.test(
    row.verificationNote + " " + Object.values(row.values).join(" "),
  );
}
function isSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function Workspace() {
  const bootstrapRecovery = useRef(new SavedTableRecovery());
  const [recoverySnapshotId, setRecoverySnapshotId] = useState<string>();
  const [view, setView] = useState<ResearchView>();
  const [jobView, setJobView] = useState<ResearchJobView>();
  const [ready, setReady] = useState(false);
  const [inlineHeightLimit, setInlineHeightLimit] = useState<number | null>(
    null,
  );
  const reportedHeight = useRef<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dismissFeedback = useCallback(() => {
    setError("");
    setNotice("");
  }, []);
  const [busy, setBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    version: number;
    title: string;
  }>();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleEditActive = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const titleTrigger = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(MAX_PAGE_SIZE);
  const pageLayout = useRef({ size: MAX_PAGE_SIZE, anchor: 0 });
  const [headerPanel, setHeaderPanel] = useState<"search" | "filter" | null>(
    null,
  );
  const [treeOpen, setTreeOpen] = useState(false);
  const [sort, setSort] = useState<{ field: string; ascending: boolean }>();
  const [selectedId, setSelectedId] = useState("");
  const [field, setField] = useState("");
  const [tab, setTab] = useState("actions");
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState("");
  const [importText, setImportText] = useState("");
  const importDialog = useRef<HTMLDialogElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const updateDialog = useRef<HTMLDialogElement>(null);
  const proposalReviewDialog = useRef<HTMLDialogElement>(null);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const [manualCorrection, setManualCorrection] = useState(false);
  const checkpointDialog = useRef<HTMLDialogElement>(null);
  const queryFeedbackDialog = useRef<HTMLDialogElement>(null);
  const [queryFeedbackOpen, setQueryFeedbackOpen] = useState(false);
  const [updateQuestion, setUpdateQuestion] = useState("");
  const [updateExisting, setUpdateExisting] = useState(true);
  const [updateDiscovery, setUpdateDiscovery] = useState(false);
  const [identityFields, setIdentityFields] = useState<string[]>([]);
  const continuationContext = useRef<
    { snapshotId: string; revision: number } | undefined
  >(undefined);
  const [updateRecovery, setUpdateRecovery] = useState<{
    id: string;
    snapshotId: string;
  }>();
  const [checkpointQuestion, setCheckpointQuestion] = useState("");
  const [checkpointScope, setCheckpointScope] = useState("");
  const [checkpointWork, setCheckpointWork] = useState("");
  const [savedCheckpoint, setSavedCheckpoint] = useState<ResearchCheckpoint>();
  const checkpointAttempt = useRef<
    | {
        id: string;
        arguments: Record<string, unknown>;
      }
    | undefined
  >(undefined);
  const [checkpointAttemptId, setCheckpointAttemptId] = useState("");
  const publishAttempt = useRef<
    | {
        requestId: string;
        arguments: Record<string, unknown>;
      }
    | undefined
  >(undefined);
  const reviewAttempts = useRef(new Map<string, string>());
  const headerTools = useRef<HTMLDivElement>(null);
  const headerTrigger = useRef<HTMLButtonElement | null>(null);
  const tableScroll = useRef<HTMLDivElement>(null);
  const scrollToRestore = useRef<{ top: number; left: number } | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const selectionWasActive = useRef(false);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const reconciliation = useRef<HostedViewReconciliation | null>(null);
  const cellEditActive = useRef(false);

  const navigation = useRef({
    search,
    filter,
    page,
    sort,
    selectedId,
    field,
    scrollTop: 0,
    scrollLeft: 0,
    windowOffset: view?.preview?.offset ?? 0,
  });
  navigation.current = {
    search,
    filter,
    page,
    sort,
    selectedId,
    field,
    scrollTop: tableScroll.current?.scrollTop ?? 0,
    scrollLeft: tableScroll.current?.scrollLeft ?? 0,
    windowOffset: view?.preview?.offset ?? 0,
  };
  const savedNavigation = useRef(new Map<string, typeof navigation.current>());
  const followRequest = useRef<{ id: string; origin: string } | null>(null);
  const [canAskAgent, setCanAskAgent] = useState(false);
  const [pollError, setPollError] = useState("");
  const [connectionIssue, setConnectionIssue] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dismissedRequestStatus, setDismissedRequestStatus] = useState("");
  cellEditActive.current = tab === "correct" || reviewOpen || proposalsOpen;

  function reportError(cause: unknown) {
    if (missingHostTool(cause)) {
      setConnectionIssue(true);
      setPollError(CONNECTION_RECOVERY);
      setError("");
    } else {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function accept(next: ResearchView, preserveWindow = true) {
    bootstrapRecovery.current.markAccepted();
    setJobView(undefined);
    const previous = viewRef.current;
    if (
      previous?.snapshot.id === next.snapshot.id &&
      next.revision < previous.revision
    )
      return;
    reconciliation.current?.invalidate();
    if (
      preserveWindow &&
      previous?.snapshot.id === next.snapshot.id &&
      (previous.preview?.offset ?? 0) > 0 &&
      next.preview?.offset !== previous.preview?.offset
    ) {
      const offset = previous.preview!.offset;
      const version = navigationVersion.current;
      const readVersion = reconciliation.current?.version;
      void app
        .callServerTool({
          name: "research_page",
          arguments: { snapshot_id: next.snapshot.id, offset },
        })
        .then((result) => {
          const page = extractView(result);
          if (
            viewRef.current === previous &&
            navigationVersion.current === version &&
            reconciliation.current?.version === readVersion &&
            page.snapshot.id === next.snapshot.id &&
            page.revision >= next.revision &&
            page.preview?.offset === offset
          )
            accept(page, false);
        })
        .catch(reportError);
      return;
    }
    if (previous?.snapshot.id !== next.snapshot.id) {
      if (previous)
        savedNavigation.current.set(previous.snapshot.id, {
          ...navigation.current,
          scrollTop: tableScroll.current?.scrollTop ?? 0,
          scrollLeft: tableScroll.current?.scrollLeft ?? 0,
        });
      const origin = next.requests?.find(
        (r) =>
          r.resultSnapshotId === previous?.snapshot.id &&
          r.snapshotId === next.snapshot.id,
      );
      const saved =
        savedNavigation.current.get(next.snapshot.id) ??
        (origin?.rowId
          ? {
              search: "",
              filter: "all",
              page: Math.max(
                0,
                Math.floor(
                  next.snapshot.rows.findIndex((r) => r.id === origin.rowId) /
                    pageSize,
                ),
              ),
              sort: undefined,
              selectedId: origin.rowId,
              field: origin.field ?? "",
              scrollTop: 0,
              scrollLeft: 0,
              windowOffset: next.preview?.offset ?? 0,
            }
          : undefined);
      titleEditActive.current = false;
      setEditingTitle(false);
      setSelectedId(saved?.selectedId ?? "");
      setField(saved?.field ?? presentationColumns(next.snapshot)[0].key);
      setPage(saved?.page ?? 0);
      setHeaderPanel(null);
      setTreeOpen(false);
      setFilter(saved?.filter ?? "all");
      setSearch(saved?.search ?? "");
      setSort(saved?.sort);
      setTab("actions");
      setReviewOpen(false);
      setManualCorrection(false);
      proposalReviewDialog.current?.close();
      setProposalsOpen(false);
      queryFeedbackDialog.current?.close();
      setQueryFeedbackOpen(false);
      setError("");
      setNotice("");
      scrollToRestore.current = {
        top: saved?.scrollTop ?? 0,
        left: saved?.scrollLeft ?? 0,
      };
    }
    viewRef.current = next;
    setView(next);
  }
  useLayoutEffect(() => {
    if (scrollToRestore.current) {
      tableScroll.current?.scrollTo(scrollToRestore.current);
      scrollToRestore.current = null;
    }
  }, [view?.snapshot.id]);
  useEffect(() => {
    const updateLayoutContext = (context: McpUiHostContext | undefined) => {
      // Pagination uses the host's space budget, not the height we request for
      // this page. Otherwise a short last page would shrink the page size too.
      setInlineHeightLimit(inlineHeightLimitFor(context));
    };
    const updateAgentMessaging = () =>
      setCanAskAgent(Boolean(agentMessenger(app, chatGPTMessaging())));
    window.addEventListener("openai:set_globals", updateAgentMessaging);
    window.addEventListener("focus", updateAgentMessaging);
    const reconciler = new HostedViewReconciliation({
      current: () => viewRef.current,
      navigationVersion: () => navigationVersion.current,
      editing: () => titleEditActive.current || cellEditActive.current,
      read: async (snapshotId, offset) =>
        extractView(
          await app.callServerTool({
            name: offset > 0 ? "research_page" : "research_status",
            arguments: {
              snapshot_id: snapshotId,
              ...(offset > 0 ? { offset } : {}),
            },
          }),
        ),
      accept: (next) => accept(next, false),
      onError: reportError,
    });
    reconciliation.current = reconciler;
    let connected = false;
    const retryBootstrap = () => {
      if (!connected || !app.getHostCapabilities()?.serverTools) return;
      void bootstrapRecovery.current.retry(readSavedResearch).then(
        (next) => {
          if (next && !bootstrapRecovery.current.hasAccepted) {
            accept(next, false);
            setError("");
          }
        },
        () => {
          if (!bootstrapRecovery.current.hasAccepted)
            setError(SAVED_TABLE_LOAD_ERROR);
        },
      );
    };
    app.ontoolinput = ({ arguments: input }) => {
      bootstrapRecovery.current.captureInput(input);
      setRecoverySnapshotId(bootstrapRecovery.current.snapshotId);
      retryBootstrap();
    };
    app.ontoolresult = (result) => {
      bootstrapRecovery.current.captureResult(result);
      setRecoverySnapshotId(bootstrapRecovery.current.snapshotId);
      try {
        if (
          result.structuredContent &&
          typeof result.structuredContent === "object" &&
          "kind" in result.structuredContent &&
          result.structuredContent.kind === "research_job_status"
        ) {
          if (result.isError)
            throw new Error("Unable to read the saved research job.");
          const job = researchJobViewSchema.parse(result.structuredContent);
          bootstrapRecovery.current.markAccepted();
          reconciler.invalidate();
          setJobView(job);
          setError("");
          return;
        }
        const next = extractView(result);
        if (!bootstrapRecovery.current.hasAccepted)
          bootstrapRecovery.current.assertTarget(next);
        if (reconciler.hostResult(next)) setError("");
      } catch (e) {
        if (!viewRef.current && !bootstrapRecovery.current.hasAccepted) {
          bootstrapRecovery.current.markFailed();
          setError(SAVED_TABLE_LOAD_ERROR);
          retryBootstrap();
        } else reportError(e);
      }
    };
    app.onhostcontextchanged = (context) => {
      if (context.theme) applyDocumentTheme(context.theme);
      if (context.styles?.variables)
        applyHostStyleVariables(context.styles.variables);
      updateAgentMessaging();
      updateLayoutContext(app.getHostContext());
    };
    app.ontoolcancelled = () =>
      setError("The tool call was cancelled. Reopen the research to continue.");
    app.onerror = reportError;
    void app
      .connect()
      .then(() => {
        connected = true;
        setReady(true);
        const context = app.getHostContext();
        updateLayoutContext(context);
        if (context?.theme) applyDocumentTheme(context.theme);
        updateAgentMessaging();
        reconciler.hostConnected(
          !!app.getHostCapabilities()?.serverTools &&
            context?.researchPreview !== true,
        );
        retryBootstrap();
      })
      .catch((e) =>
        setError(`Unable to connect to the MCP Apps host: ${String(e)}`),
      );
    return () => {
      connected = false;
      reconciler.dispose();
      window.removeEventListener("openai:set_globals", updateAgentMessaging);
      window.removeEventListener("focus", updateAgentMessaging);
    };
  }, []);

  useEffect(() => {
    if (!ready || !jobView) return;
    const panel = document.querySelector<HTMLElement>(".job-status-panel");
    if (!panel) return;
    const measure = () => {
      const height = Math.min(
        inlineHeightLimit ?? 560,
        Math.ceil(panel.getBoundingClientRect().height),
      );
      if (height === reportedHeight.current) return;
      reportedHeight.current = height;
      void app.sendSizeChanged({ height }).catch(() => {
        reportedHeight.current = null;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [ready, Boolean(jobView), inlineHeightLimit]);

  async function readResearchJob(resume = false) {
    if (!jobView) return;
    const result = await app.callServerTool({
      name: resume ? "sourcesql_start_job" : "sourcesql_job_status",
      arguments: { job_id: jobView.job.job_id },
    });
    if (result.isError) {
      if (resume) {
        await readResearchJob(false);
        return;
      }
      throw new Error(
        "Unable to read the saved job. Check its status before trying again.",
      );
    }
    if (!result.structuredContent)
      throw new Error("The job response was not confirmed.");
    setJobView(parseJobReceipt(result.structuredContent));
  }

  async function openJobResult() {
    if (!jobView?.job.result_id || jobView.job.status !== "completed") return;
    const result = await app.callServerTool({
      name: "open_research",
      arguments: {
        result_ref: {
          result_id: jobView.job.result_id,
          snapshot_id: `job-${jobView.job.job_id}`,
          title: "Saved research result",
        },
      },
    });
    accept(extractView(result));
  }

  async function perform(work: () => Promise<void>) {
    reconciliation.current?.invalidate();
    setPendingNavigation(undefined);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }
  const navigationVersion = useRef(0);
  const tableTransition = useRef<ViewTransition | null>(null);
  const tableEntrance = useRef<Animation | null>(null);
  function navigate(snapshotId: string) {
    setError("");
    setNotice("");
    setTreeOpen(false);
    // Reading another table must not disable or dim the current workspace.
    void open(snapshotId).catch(reportError);
  }
  async function open(snapshotId?: string) {
    followRequest.current = null;
    const version = ++navigationVersion.current;
    const readVersion = reconciliation.current?.version;
    const previous = viewRef.current;
    const isCurrent = () =>
      version === navigationVersion.current &&
      reconciliation.current?.version === readVersion;
    setPendingNavigation({
      version,
      title:
        previous?.snapshots.find((snapshot) => snapshot.id === snapshotId)
          ?.title ?? "saved research",
    });
    try {
      const next = await readNavigation({
        snapshotId,
        current: previous,
        savedWindow: snapshotId
          ? savedNavigation.current.get(snapshotId)
          : undefined,
        read: async (arguments_) =>
          extractView(
            await app.callServerTool({
              name: "open_research",
              arguments: arguments_,
            }),
          ),
      });
      if (!isCurrent()) return;
      if (
        !previous ||
        previous.snapshot.id === next.snapshot.id ||
        document.visibilityState === "hidden" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        tableTransition.current?.skipTransition();
        tableEntrance.current?.cancel();
        accept(next, false);
        return;
      }

      // Returning to any ancestor reverses the zoom; other table switches enter.
      const parents = new Map(
        [...previous.snapshots, ...next.snapshots].map((snapshot) => [
          snapshot.id,
          snapshot.parentSnapshotId,
        ]),
      );
      const isDescendant = (child: string, ancestor: string) => {
        const visited = new Set<string>();
        let parent = parents.get(child);
        while (parent && !visited.has(parent)) {
          if (parent === ancestor) return true;
          visited.add(parent);
          parent = parents.get(parent);
        }
        return false;
      };
      const direction = isDescendant(previous.snapshot.id, next.snapshot.id)
        ? "out"
        : "in";
      tableTransition.current?.skipTransition();
      tableEntrance.current?.cancel();
      if (!document.startViewTransition) {
        flushSync(() => accept(next, false));
        const surface =
          tableScroll.current?.closest<HTMLElement>(".records-surface");
        tableEntrance.current =
          surface?.animate(
            [
              {
                transform: `scale(${direction === "in" ? 0.82 : 1.18})`,
                opacity: 0.4,
              },
              { transform: "scale(1)", opacity: 1 },
            ],
            { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
          ) ?? null;
        titleTrigger.current?.focus({ preventScroll: true });
        return;
      }
      document.documentElement.dataset.tableTransition = direction;
      const transition = document.startViewTransition(() => {
        if (!isCurrent()) return;
        // Layout effects restore scroll before the browser captures the new table.
        flushSync(() => accept(next, false));
      });
      tableTransition.current = transition;
      void transition.ready.catch(() => {});
      try {
        await transition.updateCallbackDone;
        // An interrupted animation must not turn successful navigation into an error.
        await transition.finished.catch(() => {});
      } finally {
        if (tableTransition.current === transition) {
          tableTransition.current = null;
          delete document.documentElement.dataset.tableTransition;
          requestAnimationFrame(() =>
            titleTrigger.current?.focus({ preventScroll: true }),
          );
        }
      }
    } catch (cause) {
      // An obsolete read must not report an error on a newer table or edit.
      if (isCurrent()) throw cause;
    } finally {
      setPendingNavigation((pending) =>
        pending?.version === version ? undefined : pending,
      );
    }
  }
  async function changeWindow(offset: number) {
    const current = viewRef.current;
    if (!current) return;
    const version = ++navigationVersion.current;
    const readVersion = reconciliation.current?.version;
    const next = extractView(
      await app.callServerTool({
        name: "research_page",
        arguments: { snapshot_id: current.snapshot.id, offset },
      }),
    );
    if (
      version !== navigationVersion.current ||
      reconciliation.current?.version !== readVersion ||
      viewRef.current?.snapshot.id !== current.snapshot.id
    )
      return;
    setPage(0);
    setSelectedId("");
    accept(next, false);
  }
  async function checkResearch() {
    const snapshotId = viewRef.current?.snapshot.id;
    const version = navigationVersion.current;
    const readVersion = reconciliation.current?.version;
    if (!snapshotId) return;
    const next = extractView(
      await app.callServerTool({
        name: "research_status",
        arguments: { snapshot_id: snapshotId },
      }),
    );
    if (
      viewRef.current?.snapshot.id !== snapshotId ||
      navigationVersion.current !== version ||
      reconciliation.current?.version !== readVersion
    )
      return;
    const follow = followRequest.current;
    const request = next.requests?.find((r) => r.id === follow?.id);
    if (
      request?.status === "completed" &&
      request.resultSnapshotId &&
      !request.resultArchivedAt &&
      follow?.origin === snapshotId
    ) {
      await open(request.resultSnapshotId);
    } else {
      accept(next);
      if (request && request.status !== "pending") followRequest.current = null;
    }
    setPollError("");
    setConnectionIssue(false);
  }
  const pendingIds = (view?.requests ?? [])
    .filter((r) => r.status === "pending")
    .map((r) => r.id)
    .join(",");
  useEffect(() => {
    if (!ready || !pendingIds || connectionIssue) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          await checkResearch();
        } catch (cause) {
          if (!stopped) {
            if (missingHostTool(cause)) {
              reportError(cause);
              return;
            }
            setPollError("Couldn’t check for results. Try again.");
          }
        }
      }
      if (!stopped) timer = setTimeout(poll, 8000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ready, pendingIds, view?.snapshot.id, connectionIssue]);
  async function askAgent(kind: "expand" | "refresh") {
    const sendToAgent = agentMessenger(app, chatGPTMessaging());
    if (!view || !sendToAgent)
      throw new Error(
        "Open this app in a host with agent messaging to run research.",
      );
    const snapshotId = view.snapshot.id;
    const requestId = crypto.randomUUID();
    const result = await app.callServerTool({
      name: `${kind}_research`,
      arguments: {
        request_id: requestId,
        snapshot_id: snapshotId,
        ...(selectedId
          ? { row_id: selectedId, ...(field ? { field } : {}) }
          : {}),
        ...(kind === "expand" ? { question: question.trim() } : {}),
      },
    });
    if (result.isError)
      throw new Error(
        result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      );
    const prepared = result.structuredContent as unknown as {
      view: ResearchView;
      prompt: string;
      request: ResearchRequestSummary;
    };
    accept(prepared.view);
    followRequest.current = { id: requestId, origin: snapshotId };
    let rejected = false;
    try {
      // Choose one supported route before sending. Never retry via another
      // bridge after a timeout: the first message may already have arrived.
      const sent = await sendToAgent(prepared.prompt);
      if (sent.isError) {
        rejected = true;
        throw new Error("The host declined the research request.");
      }
      setTab("actions");
    } catch (cause) {
      if (rejected) followRequest.current = null;
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        if (rejected)
          accept(
            extractView(
              await app.callServerTool({
                name: "finish_research",
                arguments: {
                  request_id: requestId,
                  status: "failed",
                  error: `Unable to send to the host: ${message}`.slice(
                    0,
                    1000,
                  ),
                },
              }),
            ),
          );
      } catch {
        /* A returned result may have already completed the request. */
      }
      throw new Error(
        `${message} Research was not confirmed. Check request status before retrying.`,
      );
    }
  }
  async function checkForUpdates() {
    const sendToAgent = agentMessenger(app, chatGPTMessaging());
    if (!view || !sendToAgent)
      throw new Error(
        "Open this app in a host with agent messaging to check for updates.",
      );
    if (
      continuationContext.current?.snapshotId !== view.snapshot.id ||
      continuationContext.current.revision !== view.revision
    )
      throw new Error(
        "The table or its corrections changed while this form was open. Close it and review the current table before checking for updates.",
      );
    if (updateRecovery?.snapshotId === view.snapshot.id)
      throw new Error(
        `Inspect existing update request_id ${updateRecovery.id} before starting another check.`,
      );
    const requestId = crypto.randomUUID();
    const args = manualUpdateArguments(view, {
      requestId,
      question: updateQuestion,
      existing: updateExisting,
      discovery: updateDiscovery,
      identityFields,
      rowId: selectedId || undefined,
      field: field || undefined,
    });
    setUpdateRecovery({ id: requestId, snapshotId: view.snapshot.id });
    try {
      const result = await app.callServerTool({
        name: "check_research_updates",
        arguments: args,
      });
      if (result.isError)
        throw new Error(
          result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
        );
      const prepared = result.structuredContent as unknown as {
        prompt: string;
        view?: ResearchView;
      };
      if (typeof prepared?.prompt !== "string" || !prepared.prompt.trim())
        throw new Error("The server did not return a saved update handoff.");
      if (prepared.view) accept(prepared.view);
      const sent = await sendToAgent(prepared.prompt);
      if (sent.isError) throw new Error("The host declined the update check.");
      updateDialog.current?.close();
      setUpdateRecovery(undefined);
      setNotice(
        `Update check saved. Request ID: ${requestId}. If your chat shows a prepared message, press Send to continue. Review findings before publishing.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${message} Request ID: ${requestId}. Delivery is not confirmed. Ask your agent to inspect this same request before retrying; no alternate message route was used.`,
      );
    }
  }
  async function reviewManualUpdate(
    changeId: string,
    decision: "accept" | "keep",
  ) {
    if (!view?.update) return;
    const attemptKey = `${view.update.requestId}:${changeId}:${decision}`;
    const mutationId =
      reviewAttempts.current.get(attemptKey) ?? crypto.randomUUID();
    reviewAttempts.current.set(attemptKey, mutationId);
    const result = await app.callServerTool({
      name: "review_research_update",
      arguments: {
        request_id: view.update.requestId,
        change_id: changeId,
        decision,
        expected_revision: view.update.baseRevision,
        mutation_id: mutationId,
      },
    });
    if (result.isError)
      throw new Error(
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      );
    const payload = result.structuredContent as unknown as {
      view: ResearchView;
    };
    if (!payload?.view)
      throw new Error(
        "The review response is missing its saved view. Reopen this proposal before retrying.",
      );
    accept(extractView({ ...result, structuredContent: payload.view }));
    for (const key of reviewAttempts.current.keys()) {
      if (key.startsWith(`${view.update.requestId}:${changeId}:`))
        reviewAttempts.current.delete(key);
    }
    setNotice(
      decision === "accept"
        ? "Change accepted for the next saved table. Publish after reviewing every finding."
        : "Current finding kept for the next saved table.",
    );
  }
  async function publishManualUpdate() {
    if (!view?.update) return;
    if (publishAttempt.current?.requestId !== view.update.requestId)
      publishAttempt.current = {
        requestId: view.update.requestId,
        arguments: {
          request_id: view.update.requestId,
          snapshot_id: `update-${crypto.randomUUID()}`,
          expected_revision: view.update.baseRevision,
          mutation_id: crypto.randomUUID(),
        },
      };
    const result = await app.callServerTool({
      name: "publish_research_update",
      arguments: publishAttempt.current.arguments,
    });
    accept(extractView(result));
    setNotice(
      "Reviewed update published as a new saved table. Earlier observations and corrections are preserved.",
    );
  }
  async function saveCheckpoint() {
    if (!view) return;
    if (!checkpointAttempt.current) {
      if (
        continuationContext.current?.snapshotId !== view.snapshot.id ||
        continuationContext.current.revision !== view.revision
      )
        throw new Error(
          "The table or its corrections changed while this form was open. Close it and review the current table before saving a checkpoint.",
        );
      const work = checkpointWork
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      if (work.length > 20 || work.some((item) => item.length > 1000))
        throw new Error(
          "Use at most 20 remaining-work items, each at most 1,000 characters.",
        );
      const id = crypto.randomUUID();
      checkpointAttempt.current = {
        id,
        arguments: {
          checkpoint_id: id,
          snapshot_id: view.snapshot.id,
          expected_revision: view.revision,
          question: checkpointQuestion.trim(),
          scope: checkpointScope.trim(),
          ...(selectedId
            ? { row_ids: [selectedId], ...(field ? { fields: [field] } : {}) }
            : {}),
          remaining_work: work,
        },
      };
      setCheckpointAttemptId(id);
    }
    const attempt = checkpointAttempt.current;
    try {
      const result = await app.callServerTool({
        name: "save_research_checkpoint",
        arguments: attempt.arguments,
      });
      if (result.isError)
        throw new Error(
          result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
        );
      const checkpoint = (
        result.structuredContent as unknown as {
          checkpoint: ResearchCheckpoint;
        }
      )?.checkpoint;
      if (!checkpoint?.id)
        throw new Error("Checkpoint response was not confirmed.");
      setSavedCheckpoint(checkpoint);
      setNotice(
        `Checkpoint saved: ${checkpoint.id}. It references retained data and starts no research.`,
      );
    } catch (cause) {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)} Checkpoint ID: ${attempt.id}. Retry here with the same saved ID and arguments; no new checkpoint was submitted.`,
      );
    }
  }
  async function exportCheckpoint() {
    if (!savedCheckpoint) return;
    if (!app.getHostCapabilities()?.downloadFile)
      throw new Error(
        `This host does not support downloads. Your checkpoint is saved as ${savedCheckpoint.id}; ask your agent to resume or retrieve that exact ID.`,
      );
    const result = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///checkpoint-${savedCheckpoint.id}.json`,
            mimeType: "application/json",
            text: JSON.stringify(savedCheckpoint, null, 2),
          },
        },
      ],
    });
    if (result.isError)
      throw new Error(
        "The host declined the checkpoint download. The saved checkpoint is unchanged.",
      );
    setNotice(
      `Checkpoint ${savedCheckpoint.id} sent to your host. Transfer a full research bundle when the destination needs the data too.`,
    );
  }
  async function cancelResearch(requestId: string) {
    followRequest.current = null;
    const snapshotId = viewRef.current!.snapshot.id;
    await app
      .callServerTool({
        name: "finish_research",
        arguments: {
          request_id: requestId,
          status: "cancelled",
          error:
            "Cancelled by the user. Any host search already running may finish, but cannot attach results to this request.",
        },
      })
      .then((result) => {
        if (result.isError)
          throw new Error("Could not cancel; check for completed results.");
      });
    await open(snapshotId);
  }
  async function reviewUpdate(decision: "accept" | "keep") {
    if (!view?.refresh || !selectedId || !field) return;
    accept(
      extractView(
        await app.callServerTool({
          name: "review_refresh",
          arguments: {
            request_id: view.refresh.requestId,
            row_id: selectedId,
            field,
            decision,
            expected_revision: view.refresh.parentRevision,
          },
        }),
      ),
    );
    setReviewOpen(false);
    setNotice(
      decision === "accept"
        ? "Update accepted in the parent table."
        : "Current value kept.",
    );
  }
  function finishTitleEdit(restoreFocus: boolean) {
    titleEditActive.current = false;
    setEditingTitle(false);
    if (restoreFocus)
      requestAnimationFrame(() =>
        (
          titleTrigger.current ?? menu.current?.querySelector("summary")
        )?.focus(),
      );
  }
  async function saveTitle(restoreFocus: boolean) {
    if (!view || !titleEditActive.current || busy) return;
    const title = titleDraft.trim();
    if (!title) {
      titleInput.current?.setCustomValidity("Enter a title.");
      titleInput.current?.reportValidity();
      return;
    }
    const currentTitle = view.displayTitle ?? view.snapshot.title;
    if (title === currentTitle) {
      finishTitleEdit(restoreFocus);
      return;
    }
    titleEditActive.current = false;
    await perform(async () => {
      try {
        accept(
          extractView(
            await app.callServerTool({
              name: "rename_research",
              arguments: {
                snapshot_id: view.snapshot.id,
                title,
                expected_title: currentTitle,
              },
            }),
          ),
        );
        finishTitleEdit(restoreFocus);
      } catch (error) {
        titleEditActive.current = true;
        throw error;
      }
    });
  }
  async function importSnapshot(text: string) {
    if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024)
      throw new Error("Use a research bundle smaller than 16 MB.");
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && "state" in data) {
      accept(
        extractView(
          await app.callServerTool({
            name: "import_research_bundle",
            arguments: { bundle: data },
          }),
        ),
      );
      setNotice(
        "Research bundle imported with originals, corrections and tree.",
      );
      importDialog.current?.close();
      return;
    }
    const snapshot = snapshotSchema.parse(
      data && typeof data === "object" && "snapshot" in data
        ? data.snapshot
        : data,
    );
    accept(
      extractView(
        await app.callServerTool({
          name: "import_research",
          arguments: { snapshot },
        }),
      ),
    );
    setNotice(
      "Snapshot imported. Saved corrections remain separate; exported amendments are not replayed.",
    );
    importDialog.current?.close();
    setImportText("");
  }
  const rows = useMemo(() => {
    if (!view) return [];
    const matching = view.snapshot.rows.filter((row) => {
      const amended = view.amendments.some(
        (a) => a.row_id === row.id && !a.sourceSnapshotId,
      );
      return (
        (filter !== "review" || needsReview(row)) &&
        (filter !== "amended" || amended) &&
        view.snapshot.columns.some((c) =>
          `${displayValue(row.values[c.key])} ${displayValue(effectiveValue(view, row, c.key))}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
      );
    });
    if (sort)
      matching.sort((a, b) => {
        const av = effectiveValue(view, a, sort.field),
          bv = effectiveValue(view, b, sort.field);
        return (
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : displayValue(av).localeCompare(displayValue(bv), undefined, {
                numeric: true,
              })) * (sort.ascending ? 1 : -1)
        );
      });
    return matching;
  }, [view, search, filter, sort]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  const selectedIndex = rows.findIndex((r) => r.id === selectedId);
  pageLayout.current = {
    size: pageSize,
    anchor: selectedIndex >= 0 ? selectedIndex : pageStart,
  };
  useEffect(() => {
    const viewport = tableScroll.current;
    if (!viewport) return;
    const measure = () => {
      const heading = viewport.querySelector<HTMLElement>("thead");
      const firstRow = viewport.querySelector<HTMLElement>("tbody tr");
      if (!heading || !firstRow) return;
      const footer = viewport.querySelector<HTMLElement>(".table-footer");
      const workspace = viewport.closest<HTMLElement>(".workspace")!;
      const chromeHeight = Array.from(
        workspace.querySelectorAll<HTMLElement>(":scope > .app-header"),
      ).reduce(
        (height, element) => height + (element as HTMLElement).offsetHeight,
        0,
      );
      // Reserve the same dock clearance before and after a selection.
      const padding = getComputedStyle(viewport);
      // Layout measurements must ignore the fallback entrance transform.
      const available =
        (inlineHeightLimit === null
          ? viewport.clientHeight
          : inlineHeightLimit - chromeHeight) -
        heading.offsetHeight -
        (footer?.offsetHeight ?? 0) -
        parseFloat(padding.paddingTop) -
        parseFloat(padding.paddingBottom) -
        (viewport.querySelector<HTMLElement>(".refresh-context")
          ?.offsetHeight ?? 0);
      const rowHeight = firstRow.offsetHeight;
      const size = Math.max(
        2,
        Math.min(MAX_PAGE_SIZE, Math.floor(available / rowHeight)),
      );
      if (size !== pageLayout.current.size) {
        setPage(Math.floor(pageLayout.current.anchor / size));
        setPageSize(size);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    const heading = viewport.querySelector("thead");
    if (heading) observer.observe(heading);
    measure();
    return () => observer.disconnect();
  }, [view?.snapshot.id, rows.length, pendingIds, inlineHeightLimit]);
  useEffect(() => {
    const viewport = tableScroll.current;
    if (!ready || !view || !viewport || inlineHeightLimit === null) return;
    const workspace = viewport.closest<HTMLElement>(".workspace")!;
    const measure = () => {
      // Measure content, not the flex-filled viewport or a transformed screen
      // rectangle. Persistent dock clearance keeps selection from resizing it.
      const content = [
        ...Array.from(
          workspace.querySelectorAll<HTMLElement>(":scope > .app-header"),
        ),
        ...Array.from(viewport.children),
      ];
      const padding = getComputedStyle(viewport);
      const contentHeight =
        content.reduce(
          (height, element) => height + (element as HTMLElement).offsetHeight,
          0,
        ) +
        parseFloat(padding.paddingBottom) +
        parseFloat(padding.paddingTop);
      const minimum = treeOpen
        ? 260
        : tab !== "actions" || reviewOpen
          ? 360
          : 0;
      const height = Math.min(
        inlineHeightLimit,
        Math.ceil(Math.max(minimum, contentHeight)),
      );
      if (height === reportedHeight.current) return;
      reportedHeight.current = height;
      void app.sendSizeChanged({ height }).catch((error) => {
        reportedHeight.current = null;
        console.warn("Unable to request component height", error);
      });
    };
    const observer = new ResizeObserver(measure);
    for (const element of [
      ...workspace.querySelectorAll(":scope > .app-header"),
      ...viewport.children,
    ]) {
      observer.observe(element);
    }
    measure();
    return () => observer.disconnect();
  }, [
    ready,
    view?.snapshot.id,
    inlineHeightLimit,
    currentPage,
    pageSize,
    rows.length,
    selectedId,
    tab,
    reviewOpen,
    treeOpen,
    pendingIds,
    pollError,
  ]);
  const row = pageRows.find((r) => r.id === selectedId);
  const wholeRow = Boolean(row && !field);
  const linkedResearch = useMemo(
    () => (view ? researchLinks(view) : []),
    [view],
  );
  const selectionResearch = row
    ? researchForSelection(linkedResearch, row.id, field)
    : [];
  const researchActionLabel = `View ${researchScopeLabel(selectionResearch, field).toLowerCase()}`;
  const currentValue =
    view && row && field ? effectiveValue(view, row, field) : null;
  const selectedCellDiagnostic =
    row && field ? cellDiagnosticSummary(row, field) : undefined;
  const sources = sourceLinksForValue(
    row && view ? sourcesForViewSelection(view, row, field || undefined) : [],
    currentValue,
  );
  function changePage(next: number) {
    setSelectedId("");
    setTab("actions");
    setPage(next);
    tableScroll.current?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!headerTools.current?.contains(event.target as Node)) {
        setHeaderPanel(null);
        if (menu.current) menu.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (headerPanel || menu.current?.open)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (headerPanel) headerTrigger.current?.focus();
        else menu.current?.querySelector("summary")?.focus();
        setHeaderPanel(null);
        if (menu.current) menu.current.open = false;
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [headerPanel]);
  const valueKind =
    view && row && field ? correctionKind(view, row, field) : "text";
  const correction = parseCorrection(valueKind, draft);
  useEffect(() => {
    setDraft(currentValue === null ? "" : String(currentValue));
  }, [selectedId, field, currentValue, view?.snapshot.id]);
  useEffect(() => {
    if (!row) {
      if (selectedId) setSelectedId("");
      if (selectionWasActive.current)
        returnFocus.current?.focus({ preventScroll: true });
    }
    selectionWasActive.current = Boolean(row);
  }, [Boolean(row)]);
  useEffect(() => {
    if (!row) return;
    const dismiss = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !importDialog.current?.open &&
        !sourceDialog.current?.open &&
        !updateDialog.current?.open &&
        !proposalReviewDialog.current?.open &&
        !checkpointDialog.current?.open &&
        !queryFeedbackDialog.current?.open &&
        !treeOpen
      ) {
        event.preventDefault();
        if (reviewOpen) {
          setReviewOpen(false);
        } else if (tab !== "actions") {
          setTab("actions");
          requestAnimationFrame(() => actionTrigger.current?.focus());
        } else setSelectedId("");
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [Boolean(row), tab, reviewOpen, treeOpen]);
  useEffect(() => {
    setQuestion("");
  }, [selectedId, field, view?.snapshot.id]);
  function selectCell(rowId: string, key: string, target?: HTMLButtonElement) {
    if (busy) return;
    if (target) returnFocus.current = target;
    setSelectedId(rowId);
    setField(key);
    setTab("actions");
    setReviewOpen(false);
    setManualCorrection(false);
    setError("");
    setNotice("");
  }

  async function saveCorrection() {
    if (!view || !row || !field) return;
    if (correction.error) throw new Error(correction.error);
    const value = correction.value;
    accept(
      extractView(
        await app.callServerTool({
          name: "amend_observation",
          arguments: {
            snapshot_id: view.snapshot.id,
            row_id: row.id,
            field,
            value,
            expected_revision: view.revision,
            mutation_id: crypto.randomUUID(),
          },
        }),
      ),
    );
    setTab("actions");
    setNotice("Saved.");
  }
  async function visitSource(url: string) {
    await perform(async () => {
      const result = await app.openLink({ url });
      if (result.isError)
        throw new Error("The host declined to open this source.");
      sourceDialog.current?.close();
    });
  }
  async function exportResearch() {
    if (!view) return;
    if (!app.getHostCapabilities()?.downloadFile)
      throw new Error(
        "This host does not support file downloads. Use open_research to retrieve the structured snapshot and amendments.",
      );
    const bundle = await app.callServerTool({
      name: "export_research",
      arguments: { snapshot_id: view.snapshot.id },
    });
    if (bundle.isError) throw new Error("Unable to export full research data.");
    const result = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${view.snapshot.id}.json`,
            mimeType: "application/json",
            text: JSON.stringify(bundle.structuredContent, null, 2),
          },
        },
      ],
    });
    if (result.isError) throw new Error("The host declined the export.");
    setNotice(
      "Export sent to your host. It contains original evidence and separate corrections.",
    );
  }
  if (jobView)
    return (
      <div className="research-job-workspace">
        <ResearchJobStatusPanel
          view={jobView}
          busy={busy || !ready}
          error={error}
          onOpenBilling={(url) => void visitSource(url)}
          onCheck={() => void perform(() => readResearchJob())}
          onResume={() => void perform(() => readResearchJob(true))}
          onOpenResult={
            jobView.job.status === "completed" && jobView.job.result_id
              ? () => void perform(openJobResult)
              : undefined
          }
        />
        <div className="workspace-notifications">
          <UsageNoticeOverlay
            notices={jobView.usageNotices}
            onOpenBilling={(url) => void visitSource(url)}
            onDismiss={dismissUsageNotice}
          />
        </div>
      </div>
    );
  if (!view)
    return (
      <main className="loading">
        <Database size={24} />
        <h1>Opening your research</h1>
        <p>Connecting to the MCP Apps host…</p>
        {error && <p role="alert">{error}</p>}
        {ready && recoverySnapshotId && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const next =
                  await bootstrapRecovery.current.readSaved(readSavedResearch);
                accept(next, false);
              })
            }
          >
            Load saved research
          </Button>
        )}
        {ready && !recoverySnapshotId && error && (
          <p>{SAVED_TABLE_TARGET_MISSING}</p>
        )}
      </main>
    );
  const columns = presentationColumns(view.snapshot);
  const primaryHasValues = view.snapshot.rows.some((row) => {
    const value = effectiveValue(view, row, columns[0].key);
    return value != null && !(typeof value === "string" && value.trim() === "");
  });
  const columnWeights = columns.map((column, index) => {
    const values = view.snapshot.rows.map((row) =>
      effectiveValue(view, row, column.key),
    );
    const sourceColumn =
      /^(?:url|source_url|website|link)$/i.test(column.key) ||
      (values.some(isSourceUrl) &&
        values.every(
          (value) => value == null || value === "" || isSourceUrl(value),
        ));
    // Long source paths should not squeeze the entity and its useful fields.
    if (
      values.every(
        (value) =>
          value == null || (typeof value === "string" && value.trim() === ""),
      )
    )
      return Math.max(8, Math.min(12, column.label.length));
    if (sourceColumn) return primaryHasValues ? 16 : 32;
    const lengths = values.map((value) =>
      value == null ? 0 : displayValue(value).length,
    );
    const average =
      lengths.reduce((sum, length) => sum + length, 0) /
      Math.max(1, lengths.length);
    return Math.max(
      index === 0 ? 24 : 12,
      Math.min(36, Math.max(column.label.length, average * 0.7)),
    );
  });
  const totalWeight = columnWeights.reduce((sum, weight) => sum + weight, 0);
  const fieldLabel = columns.find((c) => c.key === field)?.label;
  const parentId = view.snapshot.parentSnapshotId;
  const parentTitle = view.snapshots.find((s) => s.id === parentId)?.title;
  const pending =
    view.requests?.filter(
      (r) => r.status === "pending" && r.snapshotId === view.snapshot.id,
    ) ?? [];
  const latestRequest = view.requests?.findLast(
    (r) => r.snapshotId === view.snapshot.id,
  );
  const showCancelledRequest =
    latestRequest?.status === "cancelled" &&
    latestRequest.id !== dismissedRequestStatus;
  const refreshChange = view.refresh?.changes.find(
    (c) => c.rowId === selectedId && c.field === field,
  );
  const cellProposals = cellUpdateProposals(view, selectedId, field);
  const updateReadiness = view.update
    ? updateReviewReadiness(view.update)
    : undefined;
  const showProposalReview = () => {
    reconciliation.current?.invalidate();
    setHeaderPanel(null);
    if (menu.current?.open) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
    setProposalsOpen(true);
    proposalReviewDialog.current?.showModal();
  };
  const updateAvailability = manualUpdateAvailability(view, canAskAgent);
  const refreshLabel = selectedId
    ? field
      ? "Refresh selected cell"
      : "Refresh selected row"
    : "Refresh results";
  const captured = new Date(
    view.snapshot.capturePrecision === "instant"
      ? view.snapshot.capturedAt
      : `${view.snapshot.capturedAt}T12:00:00`,
  ).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const correctionError = Boolean(
    error &&
    tab === "correct" &&
    row &&
    (!cellProposals.length || manualCorrection),
  );
  const feedbackMessage = error
    ? correctionError
      ? ""
      : error
    : pendingNavigation
      ? `Opening ${pendingNavigation.title}…`
      : notice;
  const feedbackKind = error
    ? "error"
    : pendingNavigation
      ? "progress"
      : "success";
  return (
    <main className="workspace">
      <header className="app-header">
        <div className="report-heading" ref={headerTools}>
          {parentId && (
            <Button
              variant="ghost"
              className="header-icon back-button"
              aria-label={`Back to ${parentTitle ?? "parent results"}`}
              title={`Back to ${parentTitle ?? "parent results"}`}
              disabled={busy}
              onClick={() => navigate(parentId)}
            >
              <ArrowLeft />
            </Button>
          )}
          <div className="result-title">
            {editingTitle ? (
              <form
                className="title-editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle(true);
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget))
                    void saveTitle(false);
                }}
              >
                <Input
                  ref={titleInput}
                  autoFocus
                  required
                  maxLength={150}
                  aria-label="Results title"
                  enterKeyHint="done"
                  value={titleDraft}
                  disabled={busy}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    e.target.setCustomValidity("");
                    setTitleDraft(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      finishTitleEdit(true);
                    }
                  }}
                />
                <Button
                  type="submit"
                  variant="ghost"
                  aria-label="Save title"
                  disabled={busy}
                >
                  <Check />
                </Button>
              </form>
            ) : (
              <h1 aria-label={view.displayTitle ?? view.snapshot.title}>
                {
                  <button
                    type="button"
                    className="title-trigger"
                    ref={titleTrigger}
                    aria-label={`Open research tree: ${view.displayTitle ?? view.snapshot.title}`}
                    title={view.displayTitle ?? view.snapshot.title}
                    aria-haspopup="dialog"
                    aria-expanded={treeOpen}
                    aria-controls="research-tree-panel"
                    disabled={busy}
                    onClick={() => {
                      if (menu.current) menu.current.open = false;
                      setHeaderPanel(null);
                      setTreeOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        if (menu.current) menu.current.open = false;
                        setHeaderPanel(null);
                        setTreeOpen(true);
                      }
                    }}
                  >
                    <span>{view.displayTitle ?? view.snapshot.title}</span>
                    <ListTree aria-hidden="true" />
                  </button>
                }
              </h1>
            )}
          </div>
          <div className="header-tools">
            <Button
              variant="ghost"
              className={`header-icon ${search ? "is-active" : ""}`}
              aria-label="Search results"
              title={search ? `Search: ${search}` : "Search results"}
              aria-expanded={headerPanel === "search"}
              aria-controls="search-panel"
              onClick={(e) => {
                headerTrigger.current = e.currentTarget;
                if (menu.current) menu.current.open = false;
                setHeaderPanel(headerPanel === "search" ? null : "search");
              }}
            >
              <Search />
              {search && <span className="active-dot" />}
            </Button>
            <Button
              variant="ghost"
              className={`header-icon ${filter !== "all" ? "is-active" : ""}`}
              aria-label="Filter results"
              title={filter === "all" ? "Filter results" : "Filter active"}
              aria-expanded={headerPanel === "filter"}
              aria-controls="filter-panel"
              onClick={(e) => {
                headerTrigger.current = e.currentTarget;
                if (menu.current) menu.current.open = false;
                setHeaderPanel(headerPanel === "filter" ? null : "filter");
              }}
            >
              <SlidersHorizontal />
              {filter !== "all" && <span className="active-dot" />}
            </Button>
            {headerPanel === "search" && (
              <div
                className="header-popover search-panel"
                id="search-panel"
                role="region"
                aria-label="Search results"
              >
                <Input
                  autoFocus
                  aria-label="Search results"
                  placeholder="Search results…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
                {search && (
                  <Button
                    variant="ghost"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearch("");
                      setPage(0);
                    }}
                  >
                    <X />
                  </Button>
                )}
              </div>
            )}
            {headerPanel === "filter" && (
              <div
                className="header-popover filter-panel"
                id="filter-panel"
                role="group"
                aria-label="Filter results"
              >
                {[
                  ["all", "All results"],
                  ["review", "Needs review"],
                  ["amended", "Corrected"],
                ].map(([value, label], i) => (
                  <Button
                    key={value}
                    autoFocus={i === 0}
                    variant="ghost"
                    aria-pressed={filter === value}
                    onClick={() => {
                      setFilter(value);
                      setPage(0);
                      setHeaderPanel(null);
                      headerTrigger.current?.focus();
                    }}
                  >
                    {label}
                    <Check className={filter === value ? "" : "invisible"} />
                  </Button>
                ))}
              </div>
            )}
            <details className="more-menu" ref={menu}>
              <summary
                aria-label="Table options"
                title="Table options"
                onClick={() => setHeaderPanel(null)}
              >
                <MoreHorizontal size={20} />
              </summary>
              <div className="menu-items">
                <Button
                  variant="ghost"
                  aria-haspopup="dialog"
                  aria-expanded={queryFeedbackOpen}
                  aria-controls="query-feedback-dialog"
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    setHeaderPanel(null);
                    setQueryFeedbackOpen(true);
                    queryFeedbackDialog.current?.showModal();
                  }}
                >
                  <FileText />
                  How this table was built
                </Button>
                <Button
                  variant="ghost"
                  disabled={
                    !canAskAgent ||
                    busy ||
                    pending.length > 0 ||
                    connectionIssue
                  }
                  title={
                    canAskAgent
                      ? refreshLabel
                      : "Open in a host with agent messaging to refresh"
                  }
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    void perform(() => askAgent("refresh"));
                  }}
                >
                  <RefreshCw />
                  {refreshLabel}
                </Button>
                {view.update && (
                  <Button
                    variant="ghost"
                    aria-label={
                      view.update.publishedSnapshotId
                        ? "View update history"
                        : "Review updates"
                    }
                    aria-haspopup="dialog"
                    aria-expanded={proposalsOpen}
                    aria-controls="proposal-review-dialog"
                    onClick={showProposalReview}
                  >
                    <ListChecks />
                    {view.update.publishedSnapshotId
                      ? "View update history"
                      : `Review updates${updateReadiness?.unreviewed ? ` (${updateReadiness.unreviewed})` : ""}`}
                  </Button>
                )}
                <span
                  className="menu-option-hint"
                  title={updateAvailability.reason}
                >
                  <Button
                    variant="ghost"
                    disabled={
                      busy ||
                      connectionIssue ||
                      !updateAvailability.available ||
                      pending.length > 0
                    }
                    title={
                      updateAvailability.reason ??
                      "Check existing findings, discover new entities, or both"
                    }
                    onClick={() => {
                      if (menu.current) menu.current.open = false;
                      setError("");
                      if (
                        !updateRecovery ||
                        updateRecovery.snapshotId !== view.snapshot.id
                      ) {
                        setUpdateRecovery(undefined);
                        setUpdateQuestion(
                          `Check for evidence-backed updates to ${view.displayTitle}.`.slice(
                            0,
                            1000,
                          ),
                        );
                        setUpdateExisting(view.snapshot.rows.length > 0);
                        setUpdateDiscovery(false);
                        setIdentityFields(
                          presentationColumns(view.snapshot)
                            .slice(0, 1)
                            .map((column) => column.key),
                        );
                      }
                      continuationContext.current = {
                        snapshotId: view.snapshot.id,
                        revision: view.revision,
                      };
                      updateDialog.current?.showModal();
                    }}
                  >
                    <RefreshCw />
                    Check for updates
                  </Button>
                  {!updateAvailability.available && (
                    <small>{updateAvailability.reason}</small>
                  )}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy || connectionIssue}
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    setError("");
                    setSavedCheckpoint(undefined);
                    checkpointAttempt.current = undefined;
                    setCheckpointAttemptId("");
                    setCheckpointQuestion(view.displayTitle);
                    setCheckpointScope(
                      selectedId
                        ? `${field ? "Selected field" : "Selected entity"} in ${view.displayTitle}`
                        : `All saved rows and fields in ${view.displayTitle}`,
                    );
                    setCheckpointWork("");
                    continuationContext.current = {
                      snapshotId: view.snapshot.id,
                      revision: view.revision,
                    };
                    checkpointDialog.current?.showModal();
                  }}
                >
                  <Database />
                  Save checkpoint
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    reconciliation.current?.invalidate();
                    if (menu.current) menu.current.open = false;
                    setHeaderPanel(null);
                    setTitleDraft(view.displayTitle ?? view.snapshot.title);
                    titleEditActive.current = true;
                    setEditingTitle(true);
                  }}
                >
                  <PencilLine />
                  Rename results
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    setError("");
                    importDialog.current?.showModal();
                  }}
                >
                  <Upload />
                  Import results
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    void perform(exportResearch);
                  }}
                >
                  <Download />
                  Export JSON
                </Button>
              </div>
            </details>
          </div>
        </div>
        {/* Mount the view toggle here only when a visualization is available. */}
      </header>
      <div className="workspace-content">
        <div className="workspace-notifications">
          <UsageNoticeOverlay
            notices={view.usageNotices}
            onOpenBilling={(url) => void visitSource(url)}
            onDismiss={dismissUsageNotice}
          />
          <FeedbackToast
            message={feedbackMessage}
            kind={feedbackKind}
            onDismiss={dismissFeedback}
          />
          <ResearchStatusOverlay
            key={view.snapshot.id}
            status={
              pending.length > 0 ||
              latestRequest?.status === "failed" ||
              showCancelledRequest ||
              pollError
                ? {
                    message:
                      pollError ||
                      (pending.length
                        ? "Waiting for results…"
                        : showCancelledRequest
                          ? "Research cancelled. No results were added."
                          : latestRequest?.error ||
                            "Research could not finish."),
                    kind:
                      pollError || (!pending.length && !showCancelledRequest)
                        ? "error"
                        : pending.length
                          ? "pending"
                          : "cancelled",
                    pendingRequestIds: pending.map((request) => request.id),
                    canCheck: Boolean(
                      pending.length ||
                      pollError ||
                      latestRequest?.status === "failed",
                    ),
                    canDismiss: Boolean(
                      !pending.length && showCancelledRequest && !pollError,
                    ),
                  }
                : undefined
            }
            busy={busy}
            onCheck={() => void perform(checkResearch)}
            onCancel={(requestId) =>
              void perform(() => cancelResearch(requestId))
            }
            onDismiss={() => {
              if (latestRequest) setDismissedRequestStatus(latestRequest.id);
            }}
          />
        </div>
        <section
          className="records-surface"
          aria-label="Research results"
          aria-busy={Boolean(pendingNavigation)}
        >
          <div
            ref={tableScroll}
            className="table-scroll"
            tabIndex={0}
            aria-label="Scrollable results table"
          >
            {view.refresh && (
              <div className="refresh-context">
                <span>
                  Refresh of {view.refresh.parentTitle} · Select a cell to
                  review
                </span>
                <span>
                  {
                    view.refresh.changes.filter(
                      (c) => !c.decision && c.status !== "unchanged",
                    ).length
                  }{" "}
                  to review
                </span>
              </div>
            )}
            <table
              style={{ minWidth: Math.max(340, columns.length * 112 + 36) }}
            >
              <colgroup>
                <col className="number-column" />
                {columns.map((c, i) => (
                  <col
                    key={c.key}
                    style={{
                      width: `${(columnWeights[i] / totalWeight) * 100}%`,
                    }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="row-number" scope="col">
                    #
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={
                        sort?.field === c.key
                          ? sort.ascending
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        className="sort-button"
                        title={
                          sort?.field === c.key && !sort.ascending
                            ? "Restore query order"
                            : sort?.field === c.key
                              ? "Sort descending"
                              : "Sort ascending"
                        }
                        onClick={() => {
                          setPage(0);
                          setSort((current) => nextTableSort(current, c.key));
                        }}
                      >
                        <span>{c.label}</span>
                        <ArrowUpDown size={12} />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const rowResearch = researchForSelection(
                    linkedResearch,
                    r.id,
                  );
                  return (
                    <tr
                      key={r.id}
                      className={
                        wholeRow && row?.id === r.id ? "selected-row" : ""
                      }
                    >
                      <td className="row-number">
                        <button
                          className="row-select"
                          aria-label={`Select entire result ${pageStart + i + 1}${rowResearch.length ? ". Research available" : ""}`}
                          title={
                            rowResearch.length
                              ? "Research available for this row"
                              : undefined
                          }
                          aria-pressed={wholeRow && row?.id === r.id}
                          disabled={busy}
                          onClick={(e) => selectCell(r.id, "", e.currentTarget)}
                        >
                          {pageStart + i + 1}
                          {rowResearch.length > 0 && (
                            <Expand
                              className="row-research-marker"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </td>
                      {columns.map((c, ci) => {
                        const amended = view.amendments.findLast(
                          (a) => a.row_id === r.id && a.field === c.key,
                        );
                        const change = view.refresh?.changes.find(
                          (change) =>
                            change.rowId === r.id && change.field === c.key,
                        );
                        const proposals = cellUpdateProposals(
                          view,
                          r.id,
                          c.key,
                        );
                        const pendingProposal =
                          !view.update?.publishedSnapshotId &&
                          proposals.some(
                            (proposal) => !view.update?.decisions[proposal.id],
                          );
                        const rawValue = effectiveValue(view, r, c.key);
                        const diagnostic = cellDiagnosticSummary(r, c.key);
                        const diagnosticLabel = diagnostic
                          ? `${amended ? "Original research: " : ""}${diagnostic}`
                          : undefined;
                        const missing =
                          rawValue == null ||
                          (typeof rawValue === "string" &&
                            rawValue.trim() === "");
                        const value = missing
                          ? "Not available"
                          : displayValue(rawValue);
                        const sourceUrl = isSourceUrl(rawValue);
                        const cellResearch = researchForSelection(
                          linkedResearch,
                          r.id,
                          c.key,
                        );
                        const researchLabel = researchScopeLabel(
                          cellResearch,
                          c.key,
                        );
                        const hasFieldResearch = cellResearch.some(
                          ({ request }) => request.field === c.key,
                        );
                        const markerCount =
                          Number(Boolean(amended)) + Number(hasFieldResearch);
                        return (
                          <td
                            key={c.key}
                            className={
                              row?.id === r.id && field === c.key
                                ? "selected-cell"
                                : ""
                            }
                          >
                            <button
                              className={`cell-button ${markerCount ? "has-indicators" : ""} ${markerCount === 2 ? "has-two-indicators" : ""}`}
                              data-cell={`${i}-${ci}`}
                              aria-label={`${c.label}: ${value}. Result ${pageStart + i + 1}${diagnosticLabel ? `. ${diagnosticLabel}` : ""}${amended ? (amended.sourceSnapshotId ? ". Updated" : ". Edited") : ""}${cellResearch.length ? `. ${researchLabel} available` : ""}${change ? `. ${change.decision ? "Reviewed" : change.status}` : ""}${pendingProposal ? ". Update proposal available" : ""}`}
                              aria-controls="cell-actions"
                              aria-pressed={row?.id === r.id && field === c.key}
                              disabled={busy}
                              title={`${value}${diagnosticLabel ? ` · ${diagnosticLabel}` : ""}${amended ? (amended.sourceSnapshotId ? " · Updated from research" : " · Edited") : ""}${cellResearch.length ? ` · ${researchLabel} available` : ""}`}
                              onClick={(e) =>
                                selectCell(r.id, c.key, e.currentTarget)
                              }
                              onFocus={(e) => {
                                if (row)
                                  selectCell(r.id, c.key, e.currentTarget);
                              }}
                              onKeyDown={(e) => {
                                const movement: Record<
                                  string,
                                  [number, number]
                                > = {
                                  ArrowLeft: [0, -1],
                                  ArrowRight: [0, 1],
                                  ArrowUp: [-1, 0],
                                  ArrowDown: [1, 0],
                                };
                                const move = movement[e.key];
                                if (!move) return;
                                e.preventDefault();
                                const target = e.currentTarget
                                  .closest("table")
                                  ?.querySelector<HTMLButtonElement>(
                                    `[data-cell="${i + move[0]}-${ci + move[1]}"]`,
                                  );
                                target?.focus();
                              }}
                            >
                              <span
                                className={`cell-value${missing ? " missing-value" : sourceUrl ? " source-url-value" : ""}`}
                                aria-hidden={
                                  missing || sourceUrl ? true : undefined
                                }
                              >
                                {missing
                                  ? "—"
                                  : sourceUrl
                                    ? formatSourceUrl(rawValue)
                                    : value}
                              </span>
                              {change && change.status !== "unchanged" && (
                                <span
                                  className="change-dot"
                                  title={
                                    change.decision ? "Reviewed" : change.status
                                  }
                                  aria-hidden="true"
                                />
                              )}
                              {pendingProposal && !change && (
                                <span
                                  className="change-dot"
                                  title="Update proposal available"
                                  aria-hidden="true"
                                />
                              )}
                              {markerCount > 0 && (
                                <span
                                  className="cell-indicators"
                                  aria-hidden="true"
                                >
                                  {hasFieldResearch && <Expand />}
                                  {amended &&
                                    (amended.sourceSnapshotId ? (
                                      <RefreshCw />
                                    ) : (
                                      <PencilLine />
                                    ))}
                                </span>
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && (
              <div className="empty">
                <Search size={22} />
                <h2>No matching results</h2>
                <p>Try a different search or filter.</p>
                <Button
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                    setPage(0);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
            <div className="table-footer">
              <span className="result-count" role="status">
                {view.preview && view.preview.total > view.snapshot.rows.length
                  ? `Window ${view.preview.offset + 1}–${view.preview.offset + view.snapshot.rows.length} of ${view.preview.total} results; filters apply to this window`
                  : rows.length === view.snapshot.rows.length
                    ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
                    : `${rows.length} of ${view.snapshot.rows.length} results`}
                {researchGapSummary(view.snapshot.researchQuality) && (
                  <span
                    title={researchGapSummary(view.snapshot.researchQuality)}
                  >
                    {" · Partial research"}
                  </span>
                )}
              </span>
              {view.preview &&
                view.preview.total > view.snapshot.rows.length && (
                  <nav aria-label="Data windows">
                    <Button
                      variant="ghost"
                      disabled={busy || view.preview.offset === 0}
                      onClick={() =>
                        void perform(() =>
                          changeWindow(Math.max(0, view.preview!.offset - 100)),
                        )
                      }
                    >
                      Previous window
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy || view.preview.nextOffset === null}
                      onClick={() =>
                        void perform(() =>
                          changeWindow(view.preview!.nextOffset!),
                        )
                      }
                    >
                      Next window
                    </Button>
                  </nav>
                )}
              {pageCount > 1 && (
                <nav className="pagination" aria-label="Results pages">
                  <span>
                    {pageStart + 1}–
                    {Math.min(pageStart + pageSize, rows.length)}
                  </span>
                  <Button
                    variant="ghost"
                    aria-label="Previous page"
                    disabled={busy || currentPage === 0}
                    onClick={() => changePage(currentPage - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <span aria-label={`Page ${currentPage + 1} of ${pageCount}`}>
                    {currentPage + 1} / {pageCount}
                  </span>
                  <Button
                    variant="ghost"
                    aria-label="Next page"
                    disabled={busy || currentPage === pageCount - 1}
                    onClick={() => changePage(currentPage + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </nav>
              )}
            </div>
          </div>
        </section>
        {row && (
          <div className="selection-dock">
            {reviewOpen && refreshChange && (
              <section
                className="action-panel review-panel"
                aria-label="Review update"
              >
                <div className="action-panel-heading">
                  <h2>
                    {refreshChange.status.charAt(0).toUpperCase() +
                      refreshChange.status.slice(1)}{" "}
                    · {refreshChange.label}
                  </h2>
                  <Button
                    variant="ghost"
                    autoFocus
                    aria-label="Close review"
                    onClick={() => setReviewOpen(false)}
                  >
                    <X />
                  </Button>
                </div>
                <div className="review-values">
                  <div>
                    <small>Current</small>
                    <p>{displayValue(refreshChange.previous)}</p>
                  </div>
                  <div>
                    <small>Proposed</small>
                    <p>{displayValue(refreshChange.proposed)}</p>
                  </div>
                </div>
                <p className="review-note">{refreshChange.note}</p>
                <Button
                  variant="ghost"
                  className="review-source"
                  disabled={busy}
                  onClick={() =>
                    sources.length > 1
                      ? sourceDialog.current?.showModal()
                      : sources[0] && void visitSource(sources[0].url)
                  }
                >
                  Visit source <ExternalLink />
                </Button>
                {refreshChange.decision ? (
                  <p className="review-note">
                    {refreshChange.decision === "accept"
                      ? "Accepted in the parent table."
                      : "Current value kept."}
                  </p>
                ) : (
                  <div className="review-actions">
                    <Button
                      disabled={busy}
                      onClick={() => void perform(() => reviewUpdate("keep"))}
                    >
                      Keep current
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy || !refreshChange.canAccept}
                      onClick={() => void perform(() => reviewUpdate("accept"))}
                    >
                      Accept update
                    </Button>
                  </div>
                )}
              </section>
            )}
            {tab !== "actions" && !reviewOpen && (
              <section
                className={`action-panel ${tab === "correct" ? "correction-panel" : "expand-panel"}`}
                id="cell-action-panel"
                aria-labelledby="action-title"
                key={`${view.snapshot.id}:${row.id}:${field}:${tab}`}
              >
                <div className="action-panel-heading">
                  <h2 id="action-title">
                    {tab === "correct"
                      ? `${cellProposals.length && !manualCorrection ? "Review" : "Correct"} ${fieldLabel}`
                      : tab === "research"
                        ? "Research for this selection"
                        : "What would you like to know?"}
                  </h2>
                  <Button
                    variant="ghost"
                    aria-label="Close action form"
                    onClick={() => {
                      setTab("actions");
                      requestAnimationFrame(() =>
                        actionTrigger.current?.focus(),
                      );
                    }}
                  >
                    <X />
                  </Button>
                </div>
                {tab === "research" && (
                  <div className="research-choices">
                    {selectionResearch.map(({ request, snapshot }, index) => (
                      <button
                        key={snapshot.id}
                        className="research-choice"
                        autoFocus={index === 0}
                        onClick={() => navigate(snapshot.id)}
                      >
                        <span>
                          <strong>{snapshot.title}</strong>
                          <small>
                            {request.field
                              ? columns.find((c) => c.key === request.field)
                                  ?.label
                              : "Entire row"}{" "}
                            · {request.question}
                          </small>
                        </span>
                        <ChevronRight aria-hidden="true" />
                      </button>
                    ))}
                    <Button
                      variant="ghost"
                      className="research-follow-up"
                      onClick={() => setTab("expand")}
                    >
                      <Expand /> Ask another question
                    </Button>
                  </div>
                )}
                {tab === "correct" && (
                  <div className="action-context">
                    <span>
                      <time dateTime={view.snapshot.capturedAt}>
                        {captured}
                      </time>
                    </span>
                    {selectedCellDiagnostic ? (
                      <p>Original research: {selectedCellDiagnostic}</p>
                    ) : null}
                  </div>
                )}
                {tab === "correct" &&
                  cellProposals.length > 0 &&
                  !manualCorrection &&
                  view.update && (
                    <div className="cell-proposals">
                      {cellProposals.map((change) => (
                        <CellUpdateProposal
                          key={change.id}
                          update={view.update!}
                          change={change}
                          field={field}
                          busy={busy || connectionIssue}
                          onReview={(changeId, decision) =>
                            void perform(() =>
                              reviewManualUpdate(changeId, decision),
                            )
                          }
                          onSource={(url) => void visitSource(url)}
                        />
                      ))}
                      <div className="cell-proposal-options">
                        <Button variant="ghost" onClick={showProposalReview}>
                          Review all updates
                        </Button>
                        {valueKind !== "structured" && (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setManualCorrection(true)}
                          >
                            Enter a different value
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                {tab === "correct" &&
                  (!cellProposals.length || manualCorrection) && (
                    <form
                      className="detail-form correction-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void perform(saveCorrection);
                      }}
                    >
                      {valueKind === "boolean" ? (
                        <Select
                          autoFocus
                          aria-label={fieldLabel}
                          value={draft}
                          disabled={busy}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setError("");
                          }}
                        >
                          <option value="">Not stated</option>
                          <option value="true">True</option>
                          <option value="false">False</option>
                        </Select>
                      ) : (
                        <GrowingTextarea
                          autoFocus
                          aria-label={fieldLabel}
                          value={draft}
                          maxLength={8000}
                          disabled={busy}
                          inputMode={
                            valueKind === "number" ? "decimal" : undefined
                          }
                          placeholder={
                            valueKind === "date"
                              ? "YYYY-MM-DD"
                              : valueKind === "datetime"
                                ? "YYYY-MM-DD HH:mm:ss"
                                : "Not stated"
                          }
                          aria-invalid={Boolean(correction.error || error)}
                          aria-describedby={
                            correction.error || error
                              ? "correction-error"
                              : undefined
                          }
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setError("");
                          }}
                        />
                      )}
                      {(correction.error || error) && (
                        <p
                          className="field-error"
                          id="correction-error"
                          role="alert"
                        >
                          {correction.error || error}
                        </p>
                      )}
                      <Button
                        variant="primary"
                        type="submit"
                        className="save-correction"
                        disabled={
                          busy ||
                          Boolean(correction.error) ||
                          Object.is(correction.value, currentValue)
                        }
                      >
                        {busy ? "Saving…" : "Save"}
                      </Button>
                    </form>
                  )}
                {tab === "expand" && (
                  <div className="detail-form">
                    <GrowingTextarea
                      autoFocus
                      aria-labelledby="action-title"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      maxLength={800}
                    />
                    <Button
                      variant="primary"
                      type="button"
                      className="ask-agent"
                      disabled={
                        !canAskAgent ||
                        connectionIssue ||
                        busy ||
                        !question.trim() ||
                        pending.length > 0
                      }
                      title={
                        canAskAgent
                          ? "Ask your agent to research this selection"
                          : "Open in a host with agent messaging to expand"
                      }
                      onClick={() => void perform(() => askAgent("expand"))}
                    >
                      Ask agent
                      <ArrowRight />
                    </Button>
                  </div>
                )}
              </section>
            )}
            <div
              className="action-bar"
              id="cell-actions"
              role="group"
              aria-label="Selected cell actions"
            >
              <Button
                variant={
                  tab === "expand" || tab === "research" ? "primary" : "ghost"
                }
                aria-label={
                  selectionResearch.length
                    ? researchActionLabel
                    : "Expand search"
                }
                aria-expanded={
                  selectionResearch.length === 1
                    ? undefined
                    : tab === "expand" || tab === "research"
                }
                aria-controls={
                  selectionResearch.length === 1
                    ? undefined
                    : "cell-action-panel"
                }
                disabled={busy}
                onClick={(e) => {
                  actionTrigger.current = e.currentTarget;
                  setReviewOpen(false);
                  if (selectionResearch.length === 1) {
                    navigate(selectionResearch[0].snapshot.id);
                  } else {
                    const nextTab = selectionResearch.length
                      ? "research"
                      : "expand";
                    setTab(tab === nextTab ? "actions" : nextTab);
                  }
                }}
              >
                <Expand />
                <span className="action-label-full" aria-hidden="true">
                  {selectionResearch.length
                    ? researchActionLabel
                    : "Expand search"}
                </span>
                <span className="action-label-compact" aria-hidden="true">
                  {selectionResearch.length ? "Research" : "Expand"}
                </span>
              </Button>
              <Button
                variant={tab === "correct" ? "primary" : "ghost"}
                aria-label={
                  cellProposals.length
                    ? "Review proposal"
                    : view.refresh
                      ? "Review"
                      : "Correct"
                }
                aria-expanded={tab === "correct"}
                aria-controls="cell-action-panel"
                disabled={
                  busy ||
                  wholeRow ||
                  (valueKind === "structured" && !cellProposals.length) ||
                  (Boolean(view.refresh) &&
                    !refreshChange &&
                    !cellProposals.length)
                }
                title={
                  wholeRow
                    ? "Select a cell to review or correct"
                    : view.refresh || cellProposals.length
                      ? "Review update"
                      : "Correct"
                }
                onClick={(e) => {
                  actionTrigger.current = e.currentTarget;
                  if (view.refresh && !cellProposals.length) {
                    reconciliation.current?.invalidate();
                    setReviewOpen(!reviewOpen);
                    setTab("actions");
                  } else {
                    reconciliation.current?.invalidate();
                    setTab(tab === "correct" ? "actions" : "correct");
                  }
                }}
              >
                {view.refresh || cellProposals.length ? (
                  <Check />
                ) : (
                  <PencilLine />
                )}
                <span className="action-label-full" aria-hidden="true">
                  {cellProposals.length
                    ? "Review proposal"
                    : view.refresh
                      ? "Review"
                      : "Correct"}
                </span>
                <span className="action-label-compact" aria-hidden="true">
                  {cellProposals.length || view.refresh ? "Review" : "Correct"}
                </span>
              </Button>
              {sources.length > 1 ? (
                <Button
                  variant="ghost"
                  className="source-action"
                  aria-label="Visit source"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    sourceDialog.current?.showModal();
                  }}
                >
                  <span className="action-label-full" aria-hidden="true">
                    Visit source
                  </span>
                  <span className="action-label-compact" aria-hidden="true">
                    Source
                  </span>
                  <ExternalLink />
                </Button>
              ) : (
                <a
                  className="button ghost source-action"
                  aria-label="Visit source"
                  href={sources[0]?.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open source in a new tab"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!busy && sources[0]) void visitSource(sources[0].url);
                  }}
                >
                  <span className="action-label-full" aria-hidden="true">
                    Visit source
                  </span>
                  <span className="action-label-compact" aria-hidden="true">
                    Source
                  </span>
                  <ExternalLink size={14} />
                </a>
              )}
              <span className="action-separator" aria-hidden="true" />
              <Button
                variant="ghost"
                className="dismiss-selection"
                aria-label="Clear selection"
                onClick={() => setSelectedId("")}
              >
                <X />
              </Button>
            </div>
          </div>
        )}
      </div>
      <dialog
        ref={queryFeedbackDialog}
        id="query-feedback-dialog"
        className="continuation-dialog query-feedback-dialog"
        aria-labelledby="query-feedback-title"
        onClose={() => {
          setQueryFeedbackOpen(false);
          menu.current
            ?.querySelector("summary")
            ?.focus({ preventScroll: true });
        }}
      >
        <div className="dialog-heading">
          <h2 id="query-feedback-title">How this table was built</h2>
          <Button
            variant="ghost"
            aria-label="Close query description"
            onClick={() => queryFeedbackDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        {queryFeedbackOpen && (
          <QueryFeedbackPanel feedback={view.snapshot.queryFeedback} />
        )}
      </dialog>
      <dialog
        ref={proposalReviewDialog}
        id="proposal-review-dialog"
        className="continuation-dialog updates-dialog"
        aria-labelledby="proposal-review-title"
        onClose={() => setProposalsOpen(false)}
      >
        <div className="dialog-heading">
          <h2 id="proposal-review-title">
            {view.update?.publishedSnapshotId
              ? "Update history"
              : "Review updates"}
          </h2>
          <Button
            variant="ghost"
            aria-label="Close update review"
            onClick={() => proposalReviewDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        {view.update && proposalsOpen && (
          <UpdateReviewPanel
            update={view.update}
            columns={columns}
            busy={busy || connectionIssue}
            onReview={(changeId, decision) =>
              void perform(() => reviewManualUpdate(changeId, decision))
            }
            onPublish={() => void perform(publishManualUpdate)}
            onSource={(url) => void visitSource(url)}
            onOpenPublished={(snapshotId) => navigate(snapshotId)}
          />
        )}
      </dialog>
      <dialog
        ref={updateDialog}
        className="continuation-dialog"
        aria-labelledby="update-dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="update-dialog-title">Check for updates</h2>
          <Button
            variant="ghost"
            aria-label="Close update setup"
            onClick={() => updateDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        <p className="muted-note">
          Propose a separate set of evidence-backed changes. Review it before
          publishing a new saved table.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(checkForUpdates);
          }}
        >
          <label>
            Research question
            <Textarea
              value={updateQuestion}
              maxLength={1000}
              rows={3}
              disabled={busy || Boolean(updateRecovery)}
              onChange={(event) => setUpdateQuestion(event.target.value)}
            />
          </label>
          <label className="continuation-choice">
            <input
              type="checkbox"
              checked={updateExisting}
              disabled={
                busy ||
                Boolean(updateRecovery) ||
                view.snapshot.rows.length === 0
              }
              onChange={(event) => setUpdateExisting(event.target.checked)}
            />
            <span>
              Revisit existing findings
              <small>
                {selectedId
                  ? field
                    ? "Only the selected field of the selected entity"
                    : "All fields of the selected entity"
                  : "All canonical rows and fields in this table"}
              </small>
            </span>
          </label>
          <label className="continuation-choice">
            <input
              type="checkbox"
              checked={updateDiscovery}
              disabled={busy || Boolean(updateRecovery)}
              onChange={(event) => setUpdateDiscovery(event.target.checked)}
            />
            <span>
              Discover new entities
              <small>
                Keep additions separate from changes to existing findings.
              </small>
            </span>
          </label>
          {updateDiscovery && (
            <fieldset className="identity-fields">
              <legend>Columns that identify an entity</legend>
              <p>
                Choose enough fields to distinguish similarly named entities.
              </p>
              {columns.map((column) => (
                <label className="continuation-choice" key={column.key}>
                  <input
                    type="checkbox"
                    checked={identityFields.includes(column.key)}
                    disabled={busy || Boolean(updateRecovery)}
                    onChange={(event) =>
                      setIdentityFields((current) =>
                        event.target.checked
                          ? [...current, column.key]
                          : current.filter((key) => key !== column.key),
                      )
                    }
                  />
                  <span>
                    {column.label}
                    <small>{column.key}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {updateRecovery && (
            <p className="checkpoint-receipt" role="status">
              Request ID: <code>{updateRecovery.id}</code>. Ask your agent to
              inspect this request before starting another check.
            </p>
          )}
          {error && (
            <p className="import-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-buttons">
            <Button type="button" onClick={() => updateDialog.current?.close()}>
              Close
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                busy ||
                Boolean(updateRecovery) ||
                !canAskAgent ||
                !updateQuestion.trim() ||
                (!updateExisting && !updateDiscovery) ||
                (updateDiscovery && !identityFields.length)
              }
            >
              Ask agent to check
              <ArrowRight />
            </Button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={checkpointDialog}
        className="continuation-dialog"
        aria-labelledby="checkpoint-dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="checkpoint-dialog-title">Save checkpoint</h2>
          <Button
            variant="ghost"
            aria-label="Close checkpoint setup"
            onClick={() => checkpointDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        <p className="muted-note">
          Save a compact continuation record with exact data and correction
          references. This starts no query or search.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(saveCheckpoint);
          }}
        >
          <label>
            Research question
            <Textarea
              value={checkpointQuestion}
              maxLength={4000}
              rows={2}
              disabled={
                busy || Boolean(savedCheckpoint) || Boolean(checkpointAttemptId)
              }
              onChange={(event) => setCheckpointQuestion(event.target.value)}
            />
          </label>
          <label>
            Scope
            <Input
              value={checkpointScope}
              maxLength={2000}
              disabled={
                busy || Boolean(savedCheckpoint) || Boolean(checkpointAttemptId)
              }
              onChange={(event) => setCheckpointScope(event.target.value)}
            />
          </label>
          <label>
            Remaining work{" "}
            <span className="optional-label">optional, one item per line</span>
            <Textarea
              value={checkpointWork}
              maxLength={10000}
              rows={3}
              disabled={
                busy || Boolean(savedCheckpoint) || Boolean(checkpointAttemptId)
              }
              onChange={(event) => setCheckpointWork(event.target.value)}
            />
          </label>
          <p className="muted-note">
            {selectedId
              ? `${field ? "Selected field" : "Selected entity"}: ${selectedId}${field ? ` / ${field}` : ""}`
              : "All saved rows and fields; table display filters do not narrow this scope."}
          </p>
          {checkpointAttemptId && !savedCheckpoint && (
            <p className="checkpoint-receipt" role="status">
              Checkpoint ID: <code>{checkpointAttemptId}</code>. A retry
              preserves this ID and the original arguments.
            </p>
          )}
          {savedCheckpoint && (
            <p className="checkpoint-receipt" role="status">
              Saved checkpoint: <code>{savedCheckpoint.id}</code>
              <span>
                References only. Use a full research export to transfer the
                data.
              </span>
            </p>
          )}
          {error && (
            <p className="import-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-buttons">
            <Button
              type="button"
              onClick={() => checkpointDialog.current?.close()}
            >
              Close
            </Button>
            {savedCheckpoint ? (
              <Button
                type="button"
                disabled={busy || !app.getHostCapabilities()?.downloadFile}
                title={
                  app.getHostCapabilities()?.downloadFile
                    ? "Download the compact checkpoint"
                    : "This host does not support file downloads; the checkpoint is saved server-side"
                }
                onClick={() => void perform(exportCheckpoint)}
              >
                <Download />
                Download checkpoint
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy || !checkpointQuestion.trim() || !checkpointScope.trim()
                }
              >
                {checkpointAttemptId
                  ? "Retry saved checkpoint"
                  : "Save checkpoint"}
                <Check />
              </Button>
            )}
          </div>
        </form>
      </dialog>
      <dialog
        ref={sourceDialog}
        className="source-dialog"
        aria-labelledby="source-dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="source-dialog-title">Choose a source</h2>
          <Button
            variant="ghost"
            aria-label="Close source picker"
            onClick={() => sourceDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        <p className="source-dialog-context">
          {wholeRow ? "Entire row" : fieldLabel} · Opens in a new tab
        </p>
        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}
        <div className="source-list" aria-busy={busy}>
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                if (!busy) void visitSource(source.url);
              }}
            >
              <span>
                <strong>{source.label || new URL(source.url).hostname}</strong>
                <small>{source.url}</small>
              </span>
              <ExternalLink size={16} />
            </a>
          ))}
        </div>
      </dialog>
      {treeOpen && (
        <ResearchTreePanel
          snapshots={view.snapshots}
          currentId={view.snapshot.id}
          onClose={() => {
            setTreeOpen(false);
            titleTrigger.current?.focus({ preventScroll: true });
          }}
          onSelect={(snapshotId) => {
            setTreeOpen(false);
            titleTrigger.current?.focus({ preventScroll: true });
            if (snapshotId !== view.snapshot.id) navigate(snapshotId);
          }}
        />
      )}
      <input
        hidden
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        aria-label="Import research snapshot"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void perform(async () => {
              if (file.size > 250000)
                throw new Error("Use a research bundle smaller than 16 MB.");
              await importSnapshot(await file.text());
            });
        }}
      />
      <dialog
        ref={importDialog}
        className="import-dialog"
        aria-labelledby="import-title"
      >
        <div className="dialog-heading">
          <h2 id="import-title">Import research results</h2>
          <Button
            variant="ghost"
            aria-label="Close import"
            onClick={() => importDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        <p className="muted-note">
          Paste a snapshot JSON export with its source result ID, capture date,
          columns, rows and evidence.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(() => importSnapshot(importText));
          }}
        >
          <label>
            Snapshot JSON
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={10}
              placeholder={
                '{"id": "my-research", "title": "…", "columns": […], "rows": […]}'
              }
            />
          </label>
          {error && (
            <p role="alert" className="import-error">
              {error}
            </p>
          )}
          <div className="dialog-buttons">
            <Button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload />
              Choose JSON file
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !importText.trim()}
            >
              Import snapshot
              <ArrowRight />
            </Button>
          </div>
        </form>
      </dialog>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
