// The pull request board, ported from Zeron's crates/ui/src/pull_requests.rs
// (MIT): one repository, Authored / Reviewing / All, search, sort, the
// Needs you and Starred views, and rows grouped by what they need.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useAppPanel, experimental_usePanelTabs, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  assess,
  CI_LABEL,
  compactRelativeTime,
  factsFromItem,
  GROUP_LABEL,
  GROUPS,
  matchesQuery,
  MISSING_LABEL,
  ACTION_LABEL,
  needsYou,
  relativeTime,
  requestGroup,
  rowStatus,
  SORT_OPTIONS,
  sortPullRequests,
  starKey,
  statusDescription,
  validRepository,
  type PullRequestFilter,
  type PullRequestGroup,
  type PullRequestListItem,
  type Sort,
} from "@/lib/model";
import type { PullRequestError, RepositoryChoice, rpcContract } from "../../server";
import { RepoIcon } from "@/components/project-icons/RepoIcon";
import {
  Avatar,
  Chip,
  DiffStats,
  EmptyAction,
  EmptyState,
  ERROR_COPY,
  NumberBadge,
  Segmented,
  useNow,
} from "./common";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: PullRequestError };

type PersonalView = "everything" | "needsYou" | "starred";

const FILTERS: readonly { value: PullRequestFilter; label: string }[] = [
  { value: "authored", label: "Authored" },
  { value: "reviewing", label: "Reviewing" },
  { value: "all", label: "All" },
];

/** The side-panel tab that shows one pull request. */
export const PR_TAB = {
  id: "pull-request",
  context: { kind: "nav-panel", panelId: "pull-requests" },
  availability: "action",
} as const;

export interface PullRequestTabParams {
  owner: string;
  name: string;
  number: number;
}

export function prTabParams(url: string): PullRequestTabParams {
  const [owner, name, , number] = new URL(url).pathname.replace(/^\/+/, "").split("/");
  return { owner: owner!, name: name!, number: Number(number) };
}

export function parsePrTabParams(params: unknown): PullRequestTabParams | null {
  if (typeof params !== "object" || params === null) return null;
  const { owner, name, number } = params as Record<string, unknown>;
  return typeof owner === "string" &&
    typeof name === "string" &&
    validRepository(`${owner}/${name}`) &&
    typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0
    ? { owner, name, number }
    : null;
}

function sameParams(a: PullRequestTabParams | null, b: PullRequestTabParams): boolean {
  return (
    a !== null &&
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

export function Board({ stars, onToggleStar }: { stars: string[]; onToggleStar: (url: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const panel = experimental_useAppPanel();
  const panelTabs = experimental_usePanelTabs();
  const now = useNow();
  // The pull request showing in the side panel, highlighted on the board.
  const selectedTab = panelTabs.open
    ? panelTabs.tabs.find((t) => t.key === panelTabs.selectedKey)
    : undefined;
  const selectedParams =
    selectedTab?.detail.kind === "plugin" && selectedTab.detail.tab.id === PR_TAB.id
      ? parsePrTabParams(selectedTab.detail.params)
      : null;
  const openPullRequest = (item: PullRequestListItem) => {
    const params = prTabParams(item.url);
    panel.openTab({
      tab: PR_TAB,
      params: { ...params },
      title: `#${item.number} ${item.title}`,
    });
  };

  const [choices, setChoices] = useState<RepositoryChoice[] | null>(null);
  const [repository, setRepository] = useState<string | null>(null);
  const [filter, setFilter] = useState<PullRequestFilter>("authored");
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<PullRequestListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(SORT_OPTIONS[0]!.sort);
  const [view, setView] = useState<PersonalView>("everything");
  const [collapsed, setCollapsed] = useState<PullRequestGroup[]>([]);
  const [repoQuery, setRepoQuery] = useState("");
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const generation = useRef(0);

  // Preferences and repository choices, once.
  useEffect(() => {
    let live = true;
    void Promise.all([rpc.call("preferences_get"), rpc.call("repositories")]).then(
      ([prefs, repos]) => {
        if (!live) return;
        const known = new Set(repos.choices.map((c) => c.repository.toLowerCase()));
        setChoices([
          ...repos.choices,
          ...prefs.recent
            .filter((r) => !known.has(r.toLowerCase()))
            .map((r) => ({ projectId: "", projectName: "Recent", repository: r, icon: null })),
        ]);
        setFilter(prefs.filter);
        setRepository(prefs.repository ?? repos.choices[0]?.repository ?? null);
        setReady(true);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  const fetchFirst = useCallback(
    async (refresh: boolean) => {
      if (repository === null) return;
      const id = ++generation.current;
      setLoad({ kind: "loading" });
      const result = await rpc.call("list", { repository, filter, after: null, refresh });
      if (id !== generation.current) return;
      if (!result.ok) {
        setLoad({ kind: "failed", error: result.error });
        return;
      }
      setItems(result.value.items);
      setNextCursor(result.value.nextCursor);
      setTotal(result.value.totalCount);
      setLoad({ kind: "ready" });
      // Adopt GitHub's canonical name after a rename.
      if (result.value.repository.toLowerCase() !== repository.toLowerCase()) {
        setRepository(result.value.repository);
      }
    },
    [rpc, repository, filter],
  );

  useEffect(() => {
    if (!ready) return;
    setItems([]);
    setNextCursor(null);
    setTotal(null);
    void fetchFirst(false);
  }, [ready, fetchFirst]);

  const loadMore = async () => {
    if (repository === null || nextCursor === null || loadingMore) return;
    const id = generation.current;
    setLoadingMore(true);
    const result = await rpc.call("list", { repository, filter, after: nextCursor, refresh: false });
    setLoadingMore(false);
    if (id !== generation.current) return;
    if (!result.ok) {
      setLoad({ kind: "failed", error: result.error });
      return;
    }
    setItems((current) => {
      const seen = new Set(current.map((item) => item.url));
      return [...current, ...result.value.items.filter((item) => !seen.has(item.url))];
    });
    setNextCursor(result.value.nextCursor);
  };

  const chooseRepository = (next: string) => {
    setRepository(next);
    setChoices((current) =>
      current === null || current.some((c) => c.repository.toLowerCase() === next.toLowerCase())
        ? current
        : [...current, { projectId: "", projectName: "Recent", repository: next, icon: null }],
    );
    setRepoQuery("");
    setRepoMenuOpen(false);
    void rpc.call("preferences_set", { repository: next });
  };
  const chooseFilter = (next: PullRequestFilter) => {
    setFilter(next);
    void rpc.call("preferences_set", { filter: next });
  };

  const visible = useMemo(() => {
    let list = items.filter((item) => matchesQuery(item, query));
    if (view === "needsYou") list = list.filter(needsYou);
    if (view === "starred") list = list.filter((item) => stars.includes(starKey(item.url)));
    return sortPullRequests(list, sort);
  }, [items, query, view, stars, sort]);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        items: visible.filter((item) => requestGroup(item) === group),
      })).filter((entry) => entry.items.length > 0),
    [visible],
  );

  const sortLabel = SORT_OPTIONS.find(
    (o) => o.sort.field === sort.field && o.sort.direction === sort.direction,
  )!.label;

  const typedRepo = repoQuery.trim();
  const filteredChoices = (choices ?? []).filter((choice) =>
    `${choice.repository} ${choice.projectName}`.toLowerCase().includes(typedRepo.toLowerCase()),
  );

  const count = total ?? items.length;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-[760px] px-4 pb-10 pt-6 md:px-10">
        {/* Header: count, refresh, repository */}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex items-baseline gap-2 text-xl font-medium">
            Pull requests
            {load.kind === "ready" ? (
              <span className="text-xs font-normal text-muted-foreground">{count}</span>
            ) : null}
          </h1>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Refresh"
            disabled={repository === null || load.kind === "loading"}
            onClick={() => void fetchFirst(true)}
          >
            <Icon name="ArrowReloadHorizontal" className={cn("size-4", load.kind === "loading" && "animate-spin")} />
          </Button>
          <DropdownMenu open={repoMenuOpen} onOpenChange={setRepoMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 max-w-[240px] gap-1.5 px-2 text-xs">
                <RepoIcon
                  icon={choices?.find((c) => c.repository.toLowerCase() === repository?.toLowerCase())?.icon}
                />
                <span className="truncate">{repository ?? (ready ? "Choose repository" : "Detecting repository…")}</span>
                <Icon name="ChevronDown" className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <div className="p-1" onKeyDown={(event) => event.stopPropagation()}>
                <Input
                  autoFocus
                  value={repoQuery}
                  onChange={(event) => setRepoQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && validRepository(typedRepo)) chooseRepository(typedRepo);
                  }}
                  placeholder="owner/repository"
                  aria-label="Repository"
                  className="h-8 text-xs"
                />
              </div>
              {validRepository(typedRepo) &&
              !filteredChoices.some((c) => c.repository.toLowerCase() === typedRepo.toLowerCase()) ? (
                <DropdownMenuItem onSelect={() => chooseRepository(typedRepo)}>
                  <Icon name="Search" className="size-3.5" />
                  Use {typedRepo}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">Repositories</DropdownMenuLabel>
              {filteredChoices.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No GitHub projects match.</div>
              ) : (
                filteredChoices.map((choice) => (
                  <DropdownMenuItem key={choice.repository} onSelect={() => chooseRepository(choice.repository)}>
                    <RepoIcon icon={choice.icon} />
                    <span className="min-w-0 flex-1 truncate">{choice.repository}</span>
                    <span className="max-w-[90px] truncate text-[11px] text-muted-foreground">
                      {choice.projectName}
                    </span>
                    <Icon
                      name="Check"
                      className={cn("size-3.5", choice.repository !== repository && "invisible")}
                    />
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Filters, search and sort */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Segmented label="Relationship" value={filter} options={FILTERS} onChange={chooseFilter} />
          <div className="relative min-w-[180px] flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pull requests"
              aria-label="Search pull requests"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={`Sort: ${sortLabel}`}
              >
                <Icon name={sort.direction === "asc" ? "ArrowUp" : "ArrowDown"} className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SORT_OPTIONS.map((option) => {
                const active =
                  option.sort.field === sort.field && option.sort.direction === sort.direction;
                return (
                  <DropdownMenuItem key={option.label} onSelect={() => setSort(option.sort)}>
                    <Icon name="Check" className={cn("size-3.5", !active && "invisible")} />
                    {option.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Chip
            active={view === "needsYou"}
            icon="BellDot"
            label="Needs you"
            onClick={() => setView(view === "needsYou" ? "everything" : "needsYou")}
          />
          <Chip
            active={view === "starred"}
            icon="Star"
            label="Starred"
            onClick={() => setView(view === "starred" ? "everything" : "starred")}
          />
        </div>

        {/* Board */}
        <div className="mt-4">
          {load.kind === "failed" ? (
            <EmptyState
              icon={load.error === "authentication" ? "Lock" : "Info"}
              title={ERROR_COPY[load.error][0]}
              body={ERROR_COPY[load.error][1]}
            >
              {load.error !== "rateLimited" ? (
                <EmptyAction label="Try again" onClick={() => void fetchFirst(true)} />
              ) : null}
            </EmptyState>
          ) : !ready || (load.kind === "loading" && items.length === 0) ? (
            <Skeleton />
          ) : repository === null ? (
            <EmptyState
              icon="GitPullRequest"
              title="Choose a repository"
              body="No GitHub repository was found in your BB projects. Choose one to load your open pull requests."
            />
          ) : groups.length === 0 ? (
            items.length > 0 ? (
              <EmptyState
                icon="Search"
                title="Nothing matches"
                body="No loaded pull request matches this search or view."
              >
                <EmptyAction
                  label="Clear filters"
                  onClick={() => {
                    setQuery("");
                    setView("everything");
                  }}
                />
              </EmptyState>
            ) : (
              <EmptyState
                icon="GitPullRequest"
                title={
                  filter === "authored"
                    ? "No pull requests authored by you"
                    : filter === "reviewing"
                      ? "No reviews requested"
                      : "No open pull requests"
                }
                body={
                  filter === "authored"
                    ? "Your open pull requests in this repository will appear here."
                    : filter === "reviewing"
                      ? "Pull requests waiting for your review will appear here."
                      : "This repository has no open pull requests. New ones will appear here."
                }
              >
                {filter !== "all" ? (
                  <EmptyAction label="Show all pull requests" onClick={() => chooseFilter("all")} />
                ) : null}
              </EmptyState>
            )
          ) : (
            <div className="space-y-2">
              {groups.map(({ group, items: groupItems }) => {
                const closed = collapsed.includes(group);
                return (
                  <section key={group}>
                    <button
                      type="button"
                      aria-expanded={!closed}
                      onClick={() =>
                        setCollapsed((current) =>
                          closed ? current.filter((g) => g !== group) : [...current, group],
                        )
                      }
                      className="flex h-8 cursor-pointer items-center gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
                    >
                      <Icon name={closed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
                      <span className="text-foreground">{GROUP_LABEL[group]}</span>
                      <span className="text-[11px]">{groupItems.length}</span>
                    </button>
                    {closed ? null : (
                      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
                        {groupItems.map((item) => (
                          <Row
                            key={item.url}
                            item={item}
                            now={now}
                            sortField={sort.field}
                            starred={stars.includes(starKey(item.url))}
                            onToggleStar={() => onToggleStar(item.url)}
                            selected={sameParams(selectedParams, prTabParams(item.url))}
                            onOpen={() => openPullRequest(item)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {nextCursor !== null ? (
                <div className="flex justify-center pt-2">
                  <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore
                      ? "Loading…"
                      : `Load more${total !== null ? ` (${items.length} of ${total})` : ""}`}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-busy className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex min-h-16 flex-col justify-center gap-2 px-4 py-3">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="ml-[22px] h-2.5 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function glyphColor(item: PullRequestListItem): string {
  if (item.isDraft) return "text-muted-foreground";
  if (item.mergeability === "conflicting") return "text-[var(--destructive-text)]";
  if (item.reviewDecision === "changesRequested") return "text-[var(--attention)]";
  return "text-[var(--success)]";
}

function Row({
  item,
  now,
  sortField,
  starred,
  onToggleStar,
  onOpen,
  selected,
}: {
  selected: boolean;
  item: PullRequestListItem;
  now: number;
  sortField: Sort["field"];
  starred: boolean;
  onToggleStar: () => void;
  onOpen: () => void;
}) {
  const assessment = assess(factsFromItem(item));
  const status = rowStatus(item);
  const statusTone =
    item.mergeability === "conflicting"
      ? "text-[color-mix(in_oklab,var(--destructive-text)_80%,transparent)]"
      : item.reviewDecision === "changesRequested"
        ? "text-[var(--attention)]"
        : "text-muted-foreground";
  const ciTone =
    item.ci.state === "failed"
      ? "text-[color-mix(in_oklab,var(--destructive-text)_80%,transparent)]"
      : item.ci.state === "passed"
        ? "text-[color-mix(in_oklab,var(--success)_80%,transparent)]"
        : "text-muted-foreground";
  const ciLabel = item.headRefOid
    ? `${CI_LABEL[item.ci.state]} · ${item.headRefOid.slice(0, 7)}`
    : CI_LABEL[item.ci.state];
  const ciTooltip = [
    `${CI_LABEL[item.ci.state]} · Commit: ${item.headRefOid || "unavailable"}`,
    assessment.missing.map((m) => MISSING_LABEL[m]).join(" · "),
    `Next: ${assessment.actions[0] ? ACTION_LABEL[assessment.actions[0]] : "No action suggested"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const stamp = sortField === "opened" ? item.createdAt : item.updatedAt;
  const stampLabel = sortField === "opened" ? "Opened" : "Updated";
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`${item.title}: ${item.repository} #${item.number}. ${statusDescription(item)}. Open pull request in the side panel`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex min-h-16 cursor-pointer items-center gap-4 px-4 py-2.5 outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover",
        selected && "bg-state-active hover:bg-state-active",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 text-[13px]" title={item.title}>
          <Icon
            name={item.isDraft ? "GitPullRequestDraft" : "GitPullRequest"}
            className={cn("size-3.5 shrink-0", glyphColor(item))}
          />
          <span className="min-w-0 truncate">{item.title}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 pl-[22px] text-[11px]">
          <span className="flex min-w-0 max-w-[150px] items-center gap-[5px] text-muted-foreground">
            <Avatar login={item.author} />
            <span className="truncate">{item.author || "Unknown author"}</span>
          </span>
          <NumberBadge number={item.number} draft={item.isDraft} />
          <span className={cn("truncate", ciTone)} title={ciTooltip}>
            {ciLabel}
          </span>
          {status ? <span className={cn("truncate", statusTone)}>{status}</span> : null}
        </div>
      </div>
      <div className="flex w-28 shrink-0 flex-col items-end gap-1">
        <span
          className="text-[11px] text-muted-foreground"
          title={`${stampLabel} ${relativeTime(stamp, now)} · ${new Date(stamp).toLocaleString()}`}
        >
          {sortField === "opened" ? `Opened ${compactRelativeTime(stamp, now)}` : compactRelativeTime(stamp, now)}
        </span>
        <DiffStats additions={item.additions} deletions={item.deletions} />
      </div>
      <StarButton starred={starred} onToggle={onToggleStar} />
    </div>
  );
}

export function StarButton({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  const label = starred ? "Unstar pull request" : "Star pull request";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={starred}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-state-hover"
    >
      <Icon
        name="Star"
        className={cn("size-3.5", starred ? "fill-[var(--attention)] text-[var(--attention)]" : "text-muted-foreground")}
      />
    </button>
  );
}
