// Pull request pills for the rest of BB: a segment above a thread's composer
// listing the pull requests linked to it, and an inline pill agents can write
// into a reply with `::pull-request{url="…"}`. Both open the pull request in
// the thread's side panel.
//
// The chips are styled by this plugin's own `bb-pr-` classes in app.css (a
// minimal copy of Cursor's pill and tray look), so nothing here depends on
// another plugin being installed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  experimental_useAppPanel,
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
  type ExperimentalThreadContextSegmentProps,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { isDone, lifecycle, TRAY_STATUS, trayStatus, type Lifecycle } from "@/lib/status";
import type { PullRequestSummary, rpcContract } from "../../server";
import { prTabParams } from "./board";

/** The side-panel tab for one pull request inside a thread. */
export const THREAD_PR_TAB = {
  id: "thread-pull-request",
  context: { kind: "thread" },
  availability: "action",
} as const;

const SUMMARY_REFRESH_MS = 60_000;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*\/?$/;

export function isPullRequestUrl(url: string): boolean {
  return PR_URL_RE.test(url.trim());
}

/** The pull requests linked to a thread, kept current over realtime. */
export function useLinkedPullRequests(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [urls, setUrls] = useState<string[] | null>(null);
  const load = useCallback(() => {
    rpc.call("linked_list", { threadId }).then(
      (result) => setUrls(result.urls),
      () => setUrls((current) => current ?? []),
    );
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime("links-changed", (payload) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) load();
  });
  const unlink = useCallback(
    (url: string) => {
      setUrls((current) => current?.filter((u) => u !== url) ?? null);
      void rpc.call("unlink", { threadId, url }).then((result) => setUrls(result.urls), load);
    },
    [rpc, threadId, load],
  );
  return { urls: urls ?? [], loaded: urls !== null, unlink };
}

type PrAction = "fix-conflicts" | "debug-ci" | "update-branch";

const PR_ACTION_LABEL: Record<PrAction, string> = {
  "fix-conflicts": "Fix conflicts",
  "debug-ci": "Debug CI",
  "update-branch": "Update branch",
};

function prActionFor(summary: PullRequestSummary): PrAction | null {
  if (isDone(summary)) return null;
  if (summary.mergeability === "conflicting") return "fix-conflicts";
  if (summary.ci.state === "failed") return "debug-ci";
  if (summary.behind) return "update-branch";
  return null;
}

const SUMMARY_BATCH = 20;

/** Summaries for a page's pull requests, refreshed every minute. */
export function useSummaries(urls: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const key = urls.join("\n");
  const [summaries, setSummaries] = useState<ReadonlyMap<string, PullRequestSummary>>(new Map());
  useEffect(() => {
    if (key === "") return;
    let live = true;
    const list = key.split("\n");
    const batches: string[][] = [];
    for (let index = 0; index < list.length; index += SUMMARY_BATCH) batches.push(list.slice(index, index + SUMMARY_BATCH));
    const load = (refresh: boolean) =>
      Promise.allSettled(batches.map((batch) => rpc.call("summaries", { urls: batch, refresh }))).then((results) => {
        if (!live) return;
        setSummaries((current) => {
          const next = new Map<string, PullRequestSummary>();
          for (const url of list) {
            const known = current.get(url);
            if (known) next.set(url, known);
          }
          for (const result of results) {
            if (result.status !== "fulfilled") continue;
            for (const item of result.value.items) {
              if (item.summary.ok) next.set(item.url, item.summary.value);
            }
          }
          return next;
        });
      });
    void load(false);
    const timer = window.setInterval(() => void load(false), SUMMARY_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [rpc, key]);
  return summaries;
}

/** Opens a pull request in the current surface's side panel. */
export function useOpenPullRequest() {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  return useCallback(
    (url: string, summary: PullRequestSummary | undefined) => {
      const params = prTabParams(url);
      const opened = panel.openTab({
        tab: THREAD_PR_TAB,
        params: { ...params },
        title: pullRequestTabTitle(params.number, summary, `${params.owner}/${params.name}`),
      });
      // No side panel here (a surface without one): use the full page.
      if (!opened) {
        navigate.toPluginPanel("pull-requests", {
          subPath: `pr/${params.owner}/${params.name}/${params.number}`,
        });
      }
    },
    [panel, navigate],
  );
}

// ---- Tab titles: Cursor's per-branch PR tabs read "PR #N" with a lifecycle
// icon. BB fixes a tab's icon at registration, so the title ends in an
// invisible marker that app.css matches to colour the icon.

const LIFECYCLE_MARK: Record<Lifecycle, string> = {
  open: "\u2060\u200B",
  merged: "\u2060\u200C",
  closed: "\u2060\u200D",
  draft: "\u200C\u2060",
};

/** "PR #N", ending in an invisible lifecycle marker once the status is known. */
export function pullRequestTabTitle(number: number, summary: PullRequestSummary | undefined, _fallback?: string): string {
  return `PR #${number}${summary ? LIFECYCLE_MARK[lifecycle(summary)] : ""}`;
}

/** Keeps an open pull request tab's title in step with its status. */
export function useLiveTabTitle(
  tab: { id: string; context: { kind: "thread" } | { kind: "nav-panel"; panelId: string }; availability: "action" },
  params: { owner: string; name: string; number: number } | null,
) {
  const panel = experimental_useAppPanel();
  const url = params ? `https://github.com/${params.owner}/${params.name}/pull/${params.number}` : null;
  const summary = useSummaries(url ? [url] : []).get(url ?? "");
  const title = params && summary ? pullRequestTabTitle(params.number, summary, "") : null;
  useEffect(() => {
    if (!params || title === null) return;
    // Re-opening an action tab with the same params updates that instance.
    // Only do it while this tab is selected, so it never steals focus.
    const tabs = panel.getTabs();
    const selected = tabs.tabs.find((t) => t.key === tabs.selectedKey);
    if (!tabs.open || !selected || selected.title === title) return;
    const d = selected.detail;
    if (d.kind !== "plugin" || d.tab.id !== tab.id) return;
    const p = d.params as { owner?: string; name?: string; number?: number } | null;
    if (p?.owner !== params.owner || p?.name !== params.name || p?.number !== params.number) return;
    panel.openTab({ tab, params: { ...params }, title });
  }, [panel, tab, params?.owner, params?.name, params?.number, title]);
}

/** GitHub PR Status's read of a thread environment's branch pull request. */
const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.union([
        z.object({ outcome: z.literal("available"), pullRequest: z.object({ url: z.string() }).passthrough() }),
        z.object({ outcome: z.string() }).passthrough(),
      ]),
    ),
  },
});

function branchUrl(row: unknown): string | null {
  const value = row as { outcome?: string; pullRequest?: { url?: unknown } } | undefined;
  const url = value?.outcome === "available" && typeof value.pullRequest?.url === "string" ? value.pullRequest.url : null;
  return url && isPullRequestUrl(url) ? url.replace(/\/$/, "") : null;
}

function useBranchPullRequests(environmentIds: readonly string[]): ReadonlyMap<string, string> {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: [...environmentIds],
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const id of environmentIds) {
      const url = branchUrl(data?.[id]);
      if (url) map.set(id, url);
    }
    return map;
  }, [data, environmentIds]);
}

interface ChildThread {
  id: string;
  title: string;
  environmentId: string | null;
}

function useChildThreads(threadId: string): ChildThread[] {
  const { threads } = experimental_useSidebarThreads();
  const key = useMemo(() => {
    const byParent = new Map<string, typeof threads[number][]>();
    for (const thread of threads) {
      if (thread.isArchived || thread.parentThreadId === null) continue;
      const list = byParent.get(thread.parentThreadId) ?? [];
      list.push(thread);
      byParent.set(thread.parentThreadId, list);
    }
    const found: ChildThread[] = [];
    const seen = new Set<string>([threadId]);
    const queue = [threadId];
    while (queue.length > 0) {
      for (const child of byParent.get(queue.shift()!) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        found.push({ id: child.id, title: child.displayTitle, environmentId: child.environment?.id ?? null });
      }
    }
    return JSON.stringify(found);
  }, [threads, threadId]);
  return useMemo(() => JSON.parse(key) as ChildThread[], [key]);
}

interface RelatedPullRequests {
  linked: string[];
  subscribed: string[];
}

function useRelatedPullRequests(threadId: string, childIds: readonly string[]): ReadonlyMap<string, RelatedPullRequests> {
  const rpc = useRpc<typeof rpcContract>();
  const key = [threadId, ...childIds].join("|");
  const [related, setRelated] = useState<ReadonlyMap<string, RelatedPullRequests>>(new Map());
  const load = useCallback(() => {
    const [own, ...children] = key.split("|");
    const ids = [own!, ...children];
    const valid = (urls: string[]) => urls.filter(isPullRequestUrl).map((url) => url.replace(/\/$/, ""));
    void Promise.all(
      ids.map(async (id) => {
        const [linked, subscribed] = await Promise.allSettled([
          id === own ? Promise.resolve({ urls: [] as string[] }) : rpc.call("linked_list", { threadId: id }),
          rpc.call("subscriptions_list", { threadId: id }),
        ]);
        return [
          id,
          {
            linked: linked.status === "fulfilled" ? valid(linked.value.urls) : [],
            subscribed:
              subscribed.status === "fulfilled" ? valid(subscribed.value.subscriptions.map((row) => row.url)) : [],
          },
        ] as const;
      }),
    ).then((rows) => setRelated(new Map(rows)));
  }, [rpc, key]);
  useEffect(load, [load]);
  const onChange = (payload: unknown) => {
    const changed = (payload as { threadId?: string } | null)?.threadId;
    if (changed && key.split("|").includes(changed)) load();
  };
  useRealtime("links-changed", onChange);
  useRealtime("subscriptions-changed", onChange);
  return related;
}

interface TrackItem {
  url: string;
  /** The branch's own pull request, from GitHub PR Status. */
  branch: boolean;
  linked: boolean;
  from: string | null;
  fromThreadId: string | null;
}

function useTrackItems(threadId: string, environmentId: string | null) {
  const { urls, unlink, loaded } = useLinkedPullRequests(threadId);
  const children = useChildThreads(threadId);
  const childIds = useMemo(() => children.map((child) => child.id), [children]);
  const environmentIds = useMemo(() => {
    const ids = new Set<string>();
    if (environmentId) ids.add(environmentId);
    for (const child of children) if (child.environmentId) ids.add(child.environmentId);
    return [...ids];
  }, [environmentId, children]);
  const branches = useBranchPullRequests(environmentIds);
  const related = useRelatedPullRequests(threadId, childIds);
  const items = useMemo(() => {
    const list: TrackItem[] = [];
    const seen = new Set<string>();
    const add = (url: string, item: Omit<TrackItem, "url">) => {
      const id = url.toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      list.push({ url, ...item });
    };
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const branch = environmentId ? branches.get(environmentId) : undefined;
    if (branch) add(branch, { branch: true, linked: urls.some((u) => same(u, branch)), from: null, fromThreadId: null });
    for (const url of urls) add(url, { branch: false, linked: true, from: null, fromThreadId: null });
    for (const url of related.get(threadId)?.subscribed ?? []) add(url, { branch: false, linked: false, from: null, fromThreadId: null });
    for (const child of children) {
      const childBranch = child.environmentId ? branches.get(child.environmentId) : undefined;
      if (childBranch) add(childBranch, { branch: false, linked: false, from: child.title, fromThreadId: child.id });
      const childRelated = related.get(child.id);
      for (const url of [...(childRelated?.linked ?? []), ...(childRelated?.subscribed ?? [])]) {
        add(url, { branch: false, linked: false, from: child.title, fromThreadId: child.id });
      }
    }
    return list;
  }, [urls, branches, environmentId, threadId, children, related]);
  return { items, unlink, loaded };
}

// ---- The composer tray, after Cursor's agent-prs-tray: a "PRs" chip with
// the open count, opening a tray of open pull requests, newest first, then
// the finished ones under "Done".

const FIRST_PAGE = 5;
const NEXT_PAGE = 8;

/** Newest first by creation, then by URL so the order is stable. */
function newestFirst(a: { url: string; createdAt: number | undefined }, b: { url: string; createdAt: number | undefined }) {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === undefined) return 1;
    if (b.createdAt === undefined) return -1;
    return b.createdAt - a.createdAt;
  }
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

function countLabel(count: number, word: "Open" | "Done") {
  return `${count} ${word}`;
}

function TrayRow({
  url,
  summary,
  active,
  from,
  onOpen,
  onAddToChat,
  onAction,
}: {
  url: string;
  summary: PullRequestSummary | undefined;
  active: boolean;
  from: string | null;
  onOpen: (url: string) => void;
  onAddToChat: (url: string) => void;
  onAction: (url: string, action: PrAction) => void;
}) {
  const action = summary ? prActionFor(summary) : null;
  const { owner, name, number } = prTabParams(url);
  const status = summary ? TRAY_STATUS[trayStatus(summary)] : null;
  const title = summary?.title ?? `${owner}/${name}`;
  const ariaLabel = [`#${number}`, title, status?.label].filter(Boolean).join(" ");
  return (
    <div
      role="menuitem"
      tabIndex={0}
      aria-label={ariaLabel}
      className="bb-pr-tray__row"
      data-active={active || undefined}
      onClick={(event) => {
        // Cursor: a modified click opens GitHub instead.
        if (event.metaKey || event.ctrlKey || event.shiftKey) window.open(url, "_blank", "noopener");
        else onOpen(url);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) window.open(url, "_blank", "noopener");
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(url);
        }
      }}
    >
      <span className="bb-pr-tray__leading" data-tone={status?.tone} aria-hidden="true">
        <Icon name={status?.icon ?? "GitPullRequest"} />
      </span>
      <span className="bb-pr-tray__label" title={from ? `${title} (from ${from})` : title}>
        {title}
      </span>
      <span className="bb-pr-tray__suffix">#{number}</span>
      <span className="bb-pr-tray__end">
        <span className="bb-pr-tray__actions">
          {action ? (
            <button
              type="button"
              className="bb-pr-tray__action"
              title={from ? `${PR_ACTION_LABEL[action]}: brief ${from}` : `${PR_ACTION_LABEL[action]}: brief this thread`}
              onClick={(event) => {
                event.stopPropagation();
                onAction(url, action);
              }}
            >
              {PR_ACTION_LABEL[action]}
            </button>
          ) : null}
          <button
            type="button"
            className="bb-pr-tray__icon"
            aria-label={`Add ${title} to chat`}
            title="Add to chat"
            onClick={(event) => {
              event.stopPropagation();
              onAddToChat(url);
            }}
          >
            <Icon name="Plus" />
          </button>
        </span>
        {status?.label ? <span className="bb-pr-tray__meta">{status.label}</span> : null}
      </span>
    </div>
  );
}

/** The chip above a thread's composer and its tray. */
export function LinkedPullRequestsSegment({ threadId, environment }: ExperimentalThreadContextSegmentProps) {
  const { items } = useTrackItems(threadId, environment?.id ?? null);
  const summaries = useSummaries(items.map((item) => item.url));
  const openPullRequest = useOpenPullRequest();
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [open, setOpen] = useState(false);
  const [doneShown, setDoneShown] = useState(FIRST_PAGE);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (items.length === 0) return null;

  const rows = items
    .map((item) => {
      const summary = summaries.get(item.url);
      const created = summary?.createdAt ? Date.parse(summary.createdAt) : Number.NaN;
      return { ...item, summary, createdAt: Number.isFinite(created) ? created : undefined };
    })
    .sort(newestFirst);
  const openRows = rows.filter((row) => !isDone(row.summary));
  const doneRows = rows.filter((row) => isDone(row.summary));
  const header =
    openRows.length > 0 || doneRows.length === 0 ? countLabel(openRows.length, "Open") : countLabel(doneRows.length, "Done");
  const hiddenDone = Math.max(0, doneRows.length - doneShown);

  const openOne = (url: string) => {
    setOpen(false);
    openPullRequest(url, summaries.get(url));
  };
  const addToChat = (url: string) => {
    setOpen(false);
    composer.insert(`${url} `, { at: "end" });
  };
  const runAction = (url: string, action: PrAction, target: string) => {
    setOpen(false);
    rpc.call("pr_action", { threadId: target, url, action }).then(
      (result) =>
        toast.success(`${PR_ACTION_LABEL[action]} sent`, {
          description: result.delivery === "queued" ? "Queued until the agent finishes its turn." : undefined,
        }),
      (error: unknown) =>
        toast.error(`Couldn't send ${PR_ACTION_LABEL[action]}`, {
          description: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  const renderRow = (row: (typeof rows)[number]) => (
    <TrayRow
      key={row.url}
      url={row.url}
      summary={row.summary}
      active={row.branch}
      from={row.from}
      onOpen={openOne}
      onAddToChat={addToChat}
      onAction={(url, action) => runAction(url, action, row.fromThreadId ?? threadId)}
    />
  );

  return (
    <div className="bb-pr-chips" data-bb-plugin-root="" ref={rootRef}>
      <div className="bb-pr-chips__row">
        <button
          type="button"
          className="bb-pr-chips__pill"
          data-group="pull-requests"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={openRows.length > 0 ? `PRs, ${openRows.length} open` : "PRs"}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="bb-pr-chips__label">PRs</span>
          {openRows.length > 0 ? <span className="bb-pr-chips__count">{openRows.length}</span> : null}
        </button>
      </div>
      {open ? (
        <div className="bb-pr-tray" role="menu" aria-label="Pull requests">
          <div className="bb-pr-tray__header">
            <span className="bb-pr-tray__title">{header}</span>
            <button
              type="button"
              className="bb-pr-tray__icon"
              aria-label="Minimize"
              title="Minimize (Esc)"
              onClick={() => setOpen(false)}
            >
              <Icon name="Minus" />
            </button>
          </div>
          <div className="bb-pr-tray__rows">
            {openRows.map(renderRow)}
            {doneRows.length > 0 && openRows.length > 0 ? (
              <div className="bb-pr-tray__subheader">{countLabel(doneRows.length, "Done")}</div>
            ) : null}
            {doneRows.slice(0, doneShown).map(renderRow)}
            {hiddenDone > 0 ? (
              <button
                type="button"
                className="bb-pr-tray__more"
                aria-label={`Show ${Math.min(hiddenDone, NEXT_PAGE)} more done pull ${Math.min(hiddenDone, NEXT_PAGE) === 1 ? "request" : "requests"}`}
                onClick={() => setDoneShown((count) => count + NEXT_PAGE)}
              >
                More
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Segment visibility: a branch pull request or a linked one. */
export function useLinkedPullRequestsVisible({
  threadId,
  environment,
}: {
  threadId: string;
  environment: { id: string } | null;
}): boolean {
  useRegisterThreadPanel(threadId);
  return useTrackItems(threadId, environment?.id ?? null).items.length > 0;
}

// The link decorator renders as an app overlay, outside any thread view, so
// its own panel hook has no side panel. Each thread view registers its panel
// here (this hook runs in every thread's composer), keyed by thread.
const threadPanels = new Map<string, ReturnType<typeof experimental_useAppPanel>>();

function useRegisterThreadPanel(threadId: string) {
  const panel = experimental_useAppPanel();
  useEffect(() => {
    threadPanels.set(threadId, panel);
    return () => {
      if (threadPanels.get(threadId) === panel) threadPanels.delete(threadId);
    };
  }, [threadId, panel]);
}

/** Opens a pull request in a thread's side panel; false when that thread isn't on screen. */
export function openInThreadPanel(threadId: string | null, url: string, summary: PullRequestSummary | undefined): boolean {
  const panel = threadId ? threadPanels.get(threadId) : threadPanels.size === 1 ? [...threadPanels.values()][0] : undefined;
  if (!panel) return false;
  const params = prTabParams(url);
  return panel.openTab({
    tab: THREAD_PR_TAB,
    params: { ...params },
    title: pullRequestTabTitle(params.number, summary, `${params.owner}/${params.name}`),
  });
}

/** `::pull-request{url="https://github.com/o/r/pull/1"}` in an agent's reply. */
