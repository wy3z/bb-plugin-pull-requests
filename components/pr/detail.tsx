import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Diff as Diff,
  Markdown,
  useBbNavigate,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { shortAge } from "@wy3z/bb-suite/time";
import { Icon, type IconName } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  assess,
  checkStatus,
  factsFromDetail,
  humanize,
  relativeTime,
  starKey,
  validHeadOid,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
} from "@/lib/model";
import { availableHandoffs, HANDOFFS, handoffPrompt } from "@/lib/handoff";
import { SubscribeButton } from "./listening";
import type { DiffFile, PullRequestCommit, PullRequestError, RepositoryChoice, rpcContract } from "../../server";
import { RepoIcon } from "@/components/project-icons/RepoIcon";
import { Avatar, DiffStats, EmptyAction, EmptyState, ERROR_COPY, Segmented, useNow } from "./common";

type Tone = "neutral" | "positive" | "warning" | "negative" | "merged";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  positive: "text-[var(--success)]",
  warning: "text-[var(--attention)]",
  negative: "text-[var(--destructive-text)]",
  merged: "text-[var(--color-purple-400)]",
};
const TONE_BG: Record<Tone, string> = {
  neutral: "bg-muted-foreground/10",
  positive: "bg-[color-mix(in_oklab,var(--success)_10%,transparent)]",
  warning: "bg-[color-mix(in_oklab,var(--attention)_10%,transparent)]",
  negative: "bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)]",
  merged: "bg-[color-mix(in_oklab,var(--color-purple-400)_10%,transparent)]",
};

function statusStyle(raw: string): { label: string; icon: IconName; tone: Tone } {
  switch (raw.toUpperCase().replace(/ /g, "_")) {
    case "OPEN":
      return { label: "Open", icon: "GitPullRequest", tone: "positive" };
    case "MERGED":
      return { label: "Merged", icon: "GitMerge", tone: "merged" };
    case "CLOSED":
      return { label: "Closed", icon: "CircleX", tone: "negative" };
    case "DRAFT":
      return { label: "Draft", icon: "FileText", tone: "neutral" };
    case "APPROVED":
      return { label: "Approved", icon: "Check", tone: "positive" };
    case "SUCCESS":
      return { label: "Passed", icon: "Check", tone: "positive" };
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "CANCELLED":
    case "STARTUP_FAILURE":
      return { label: humanize(raw), icon: "CircleX", tone: "negative" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", icon: "AlertTriangle", tone: "warning" };
    case "REVIEW_REQUIRED":
      return { label: "Awaiting review", icon: "Clock", tone: "warning" };
    case "IN_PROGRESS":
    case "PENDING":
    case "QUEUED":
    case "WAITING":
    case "EXPECTED":
      return { label: humanize(raw), icon: "Clock", tone: "warning" };
    default:
      return { label: humanize(raw), icon: "FileText", tone: "neutral" };
  }
}

function StatusChip({ raw }: { raw: string }) {
  const style = statusStyle(raw);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-[3px] text-xs", TONE_BG[style.tone])}>
      <Icon name={style.icon} className={cn("size-3.5", TONE_TEXT[style.tone])} />
      {style.label}
    </span>
  );
}

const REVIEW_RAW: Record<PullRequestDetail["reviewDecision"], string> = {
  approved: "APPROVED",
  changesRequested: "CHANGES_REQUESTED",
  reviewRequired: "REVIEW_REQUIRED",
  unknown: "",
};

function ciRaw(detail: PullRequestDetail): string | null {
  switch (assess(factsFromDetail(detail)).ci.state) {
    case "failed":
      return "FAILURE";
    case "pending":
      return "PENDING";
    case "passed":
      return "SUCCESS";
    case "skipped":
      return "SKIPPED";
    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-4 px-4 py-2">
      <div className="w-24 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[13px]">{children}</div>
    </div>
  );
}

function Card({ title, trailing, children }: { title?: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      {title ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] font-medium">
          <span className="flex-1">{title}</span>
          {trailing}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type Tab = "description" | "changes" | "commits" | "reviews" | "checks";

type ChecksVerdict = { label: string; icon: IconName; tone: Tone };

function checksVerdict(detail: PullRequestDetail): ChecksVerdict | null {
  if (detail.mergeability === "conflicting") return { label: "Checks Awaiting Conflict Resolution", icon: "AlertTriangle", tone: "warning" };
  switch (assess(factsFromDetail(detail)).ci.state) {
    case "failed":
      return { label: "Checks Failed", icon: "CircleX", tone: "negative" };
    case "pending":
      return { label: "Checks In Progress", icon: "Clock", tone: "warning" };
    case "passed":
      return { label: "All Checks Passed", icon: "CircleCheck", tone: "positive" };
    default:
      return null;
  }
}

function UnderlineTabs({
  value,
  onChange,
  options,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
  options: { value: Tab; label: string; count?: number; icon?: IconName; tone?: Tone }[];
}) {
  return (
    <div role="tablist" aria-label="Pull request sections" className="bb-pr-tabs flex items-end gap-4 border-b border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className="bb-pr-tab -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-0.5 pb-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground"
        >
          {option.icon ? <Icon name={option.icon} className={cn("size-3.5", option.tone ? TONE_TEXT[option.tone] : undefined)} /> : null}
          {option.label}
          {option.count !== undefined ? <span className="text-[11px] tabular-nums text-muted-foreground">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function TitleEditor({ title, onRename }: { title: string; onRename: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  const save = async () => {
    const next = draft.trim();
    if (next === "" || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(next);
    setSaving(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        disabled={saving}
        aria-label="Pull request title"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
          if (event.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        onBlur={() => void save()}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[17px] font-medium leading-[24px] outline-none focus:border-[var(--ring)]"
      />
    );
  }
  return (
    <button
      type="button"
      title="Rename pull request title"
      onClick={() => setEditing(true)}
      className="group/title flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover"
    >
      <h1 className="min-w-0 flex-1 text-[17px] font-medium leading-[24px]">{title}</h1>
      <Icon name="Edit" className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" />
    </button>
  );
}

function MergeBox({
  detail,
  busy,
  onReady,
  onMerge,
  onState,
}: {
  detail: PullRequestDetail;
  busy: string | null;
  onReady: () => void;
  onMerge: (method: "merge" | "squash" | "rebase") => void;
  onState: (state: "close" | "reopen") => void;
}) {
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const state = detail.state.toUpperCase();
  if (state === "MERGED") {
    return (
      <section className="bb-pr-merge flex items-center gap-2 rounded-lg border border-border px-4 py-3 text-[13px]">
        <Icon name="GitMerge" className={cn("size-4", TONE_TEXT.merged)} />
        Merged
      </section>
    );
  }
  if (state === "CLOSED") {
    return (
      <section className="bb-pr-merge flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-[13px]">
        <Icon name="CircleX" className={cn("size-4", TONE_TEXT.negative)} />
        <span className="flex-1">This pull request is closed.</span>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onState("reopen")}>
          {busy === "reopen" ? "Reopening…" : "Reopen"}
        </Button>
      </section>
    );
  }
  const verdict = checksVerdict(detail);
  const line =
    detail.mergeability === "conflicting"
      ? { text: "This branch has conflicts that must be resolved", tone: "negative" as Tone, icon: "AlertTriangle" as IconName }
      : verdict?.tone === "negative"
        ? { text: "Some checks were not successful", tone: "negative" as Tone, icon: "CircleX" as IconName }
        : verdict?.tone === "warning"
          ? { text: "Checks are running", tone: "warning" as Tone, icon: "Clock" as IconName }
          : verdict?.tone === "positive"
            ? { text: "All checks have passed", tone: "positive" as Tone, icon: "CircleCheck" as IconName }
            : { text: "No checks reported", tone: "neutral" as Tone, icon: "Circle" as IconName };
  return (
    <section className="bb-pr-merge overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 px-4 py-3 text-[13px]">
        <Icon name={line.icon} className={cn("size-4", TONE_TEXT[line.tone])} />
        <span className="flex-1">{line.text}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {detail.isDraft ? (
          <Button size="sm" disabled={busy !== null} onClick={onReady}>
            {busy === "ready" ? "Marking…" : "Mark as ready"}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy !== null || detail.mergeability === "conflicting"}
              onClick={() => onMerge(method)}
            >
              {busy === "merge" ? "Merging…" : "Merge pull request"}
            </Button>
            <select
              aria-label="Merge method"
              value={method}
              disabled={busy !== null}
              onChange={(event) => setMethod(event.currentTarget.value as typeof method)}
              className="h-8 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground"
            >
              <option value="squash">Squash and merge</option>
              <option value="merge">Create a merge commit</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onState("close")}>
          {busy === "close" ? "Closing…" : "Close"}
        </Button>
      </div>
    </section>
  );
}

function Commits({ url }: { url: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow();
  const [commits, setCommits] = useState<PullRequestCommit[] | null>(null);
  const [error, setError] = useState<PullRequestError | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("pr_commits", { url, refresh: false }).then((result) => {
      if (!live) return;
      if (result.ok) setCommits(result.value);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [rpc, url]);
  if (error !== null) return <EmptyState icon="Info" title="Couldn’t load commits" body={ERROR_COPY[error][1]} />;
  if (commits === null) return <div aria-busy className="h-40 animate-pulse rounded-lg border border-border" />;
  if (commits.length === 0) return <EmptyState icon="GitBranch" title="No commits" body="This pull request has no commits." />;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {[...commits].reverse().map((commit) => (
        <button
          key={commit.oid}
          type="button"
          onClick={() => navigate.openUrl(`${url}/commits/${commit.oid}`)}
          className="flex w-full items-center gap-3 border-b border-border px-4 py-2 text-left text-[13px] last:border-b-0 hover:bg-state-hover"
        >
          <Icon name="Circle" className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={commit.headline}>
            {commit.headline}
          </span>
          {commit.author ? <span className="shrink-0 text-xs text-muted-foreground">{commit.author}</span> : null}
          <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{commit.oid.slice(0, 7)}</code>
          {commit.committedAt ? (
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{shortAge(commit.committedAt, now)}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function ReviewsSummary({ detail }: { detail: PullRequestDetail }) {
  const latest = new Map<string, string>();
  for (const review of detail.reviews) {
    if (review.state && review.state !== "COMMENTED" && review.state !== "PENDING") latest.set(review.author, review.state);
  }
  const approved = [...latest.values()].filter((state) => state === "APPROVED").length;
  const changes = [...latest.values()].filter((state) => state === "CHANGES_REQUESTED").length;
  const unresolved = (detail.reviewThreads ?? []).filter((thread) => !thread.isResolved).length;
  const items: { label: string; tone: Tone; icon: IconName }[] = [];
  if (approved > 0) items.push({ label: `${approved} Approved`, tone: "positive", icon: "Check" });
  if (changes > 0) items.push({ label: `${changes} Changes requested`, tone: "warning", icon: "AlertTriangle" });
  if (detail.reviewDecision === "reviewRequired") items.push({ label: "Pending Reviews", tone: "neutral", icon: "Clock" });
  if (unresolved > 0) items.push({ label: `${unresolved} Unresolved ${unresolved === 1 ? "Comment" : "Comments"}`, tone: "warning", icon: "MessageSquare" });
  if (items.length === 0) items.push({ label: "No reviews yet", tone: "neutral", icon: "MessageSquare" });
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item.label} className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs", TONE_BG[item.tone])}>
          <Icon name={item.icon} className={cn("size-3.5", TONE_TEXT[item.tone])} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function Checks({ detail }: { detail: PullRequestDetail }) {
  const verdict = checksVerdict(detail);
  const assessment = assess(factsFromDetail(detail));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name={verdict?.icon ?? "Circle"} className={cn("size-4", TONE_TEXT[verdict?.tone ?? "neutral"])} />
        <span className="font-medium">{verdict?.label ?? (assessment.ci.state === "noChecks" ? "No checks reported" : "Checks unavailable")}</span>
        <span className="flex-1" />
        {validHeadOid(detail.headRefOid) ? <code className="font-mono text-[11px] text-muted-foreground">{detail.headRefOid.slice(0, 7)}</code> : null}
      </div>
      {detail.checks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {assessment.ci.state === "unknown" ? "CI metadata is unavailable. Refresh to try again." : "No checks reported for this commit."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="divide-y divide-border">
            {[...detail.checks]
              .sort((a, b) => checkRank(a) - checkRank(b))
              .map((check, index) => (
                <CheckRow key={`${check.name || check.context}-${index}`} check={check} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function DetailPage({
  owner,
  name,
  number,
  stars,
  onToggleStar,
  layout = "page",
  threadId,
}: {
  owner: string;
  name: string;
  number: number;
  stars: string[];
  onToggleStar: (url: string) => void;
  layout?: "page" | "panel";
  threadId?: string;
}) {
  const url = `https://github.com/${owner}/${name}/pull/${number}`;
  const inPanel = layout === "panel";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("description");
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<PullRequestError | null>(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffError, setDiffError] = useState<PullRequestError | null>(null);
  const [choices, setChoices] = useState<RepositoryChoice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const id = ++generation.current;
      setLoading(true);
      setError(null);
      const result = await rpc.call("detail", { url, refresh });
      if (id !== generation.current) return;
      setLoading(false);
      if (result.ok) setDetail(result.value);
      else setError(result.error);
    },
    [rpc, url],
  );

  const loadDiff = useCallback(
    async (refresh: boolean) => {
      setDiffError(null);
      const result = await rpc.call("diff", { url, refresh });
      if (result.ok) setDiff(result.value);
      else setDiffError(result.error);
    },
    [rpc, url],
  );

  useEffect(() => {
    setDetail(null);
    setDiff(null);
    void load(false);
  }, [load]);
  useEffect(() => {
    if (tab === "changes" && diff === null && diffError === null) void loadDiff(false);
  }, [tab, diff, diffError, loadDiff]);
  useEffect(() => {
    void rpc.call("repositories").then((r) => setChoices(r.choices));
  }, [rpc]);

  const refresh = () => {
    void load(true);
    if (diff !== null || tab === "changes") {
      setDiff(null);
      void loadDiff(true);
    }
  };

  const project = choices.find((c) => c.projectId !== "" && c.repository.toLowerCase() === `${owner}/${name}`.toLowerCase());
  const startHandoff = (kind: (typeof HANDOFFS)[number]["kind"]) => {
    if (!detail) return;
    navigate.toCompose({ projectId: project?.projectId, initialPrompt: handoffPrompt(kind, detail), focusPrompt: true });
  };

  const mutate = async (key: string, call: () => Promise<{ ok: boolean; error?: PullRequestError }>, done: string) => {
    setBusy(key);
    const result = await call();
    setBusy(null);
    if (result.ok) {
      toast(done);
      void load(true);
      return true;
    }
    toast.error(ERROR_COPY[result.error ?? "network"][0], { description: ERROR_COPY[result.error ?? "network"][1] });
    return false;
  };

  const copyUrl = () =>
    void experimental_copyToClipboard({ text: url }).then((ok) => (ok ? toast("Copied PR URL") : toast.error("Couldn’t copy the link")));

  const reviewCount = detail ? detail.reviews.length + (detail.reviewThreads?.length ?? 0) + detail.comments.length : undefined;
  const verdict = detail ? checksVerdict(detail) : null;
  const state = detail ? (detail.isDraft ? "DRAFT" : detail.state) : null;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full", inPanel ? "px-3 pb-6 pt-2" : "max-w-[860px] px-4 pb-10 pt-4 md:px-10")}>
        <div className="flex items-center gap-1">
          {inPanel ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Open as page"
              onClick={() => navigate.toPluginPanel("pull-requests", { subPath: `pr/${owner}/${name}/${number}` })}
            >
              <Icon name="Maximize2" className="size-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => navigate.toPluginPanel("pull-requests", { subPath: "" })}
            >
              <Icon name="ArrowLeft" className="size-3.5" />
              Pull requests
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Copy PR URL" onClick={copyUrl}>
            <Icon name="Link" className="size-4" />
          </Button>
          {threadId ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Add to Chat"
              onClick={() => composer.insert(`${url} `, { at: "end" })}
            >
              <Icon name="Plus" className="size-4" />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Open on GitHub" onClick={() => navigate.openUrl(url)}>
            <Icon name="ExternalLink" className="size-4" />
          </Button>
          {threadId ? <SubscribeButton threadId={threadId} url={url} /> : null}
          {detail ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-1 h-8 gap-1.5 text-xs">
                  <Icon name="Bot" className="size-3.5" />
                  Hand off
                  <Icon name="ChevronDown" className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                {availableHandoffs(detail).map((kind) => {
                  const handoff = HANDOFFS.find((h) => h.kind === kind)!;
                  return (
                    <DropdownMenuItem key={kind} onSelect={() => startHandoff(kind)}>
                      <Icon name={handoff.icon} className="size-3.5" />
                      <div className="flex min-w-0 flex-col">
                        <span>{handoff.label}</span>
                        <span className="text-[11px] text-muted-foreground">{handoff.summary}</span>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More">
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onToggleStar(url)}>
                <Icon name="Star" className="size-3.5" />
                {stars.includes(starKey(url)) ? "Unstar" : "Star"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={loading} onSelect={refresh}>
                <Icon name="ArrowReloadHorizontal" className="size-3.5" />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3">
          {state ? (
            <div className="px-2">
              <StatusChip raw={state} />
            </div>
          ) : null}
          <div className="mt-2">
            {detail ? (
              <TitleEditor
                title={detail.title}
                onRename={(title) => mutate("rename", () => rpc.call("pr_rename", { url, title }), "Renamed")}
              />
            ) : (
              <h1 className="px-2 text-[17px] font-medium">Pull request #{number}</h1>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
            {detail ? (
              <span className="flex items-center gap-1.5">
                <Avatar login={detail.author} size={18} />
                {detail.author || "Deleted account"}
              </span>
            ) : null}
            {detail ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <code className="truncate font-mono">{detail.headRefName}</code>
                <Icon name="ArrowRight" className="size-3" />
                <code className="truncate font-mono">{detail.baseRefName}</code>
              </span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <RepoIcon icon={project?.icon} />
              {owner}/{name}#{number}
            </span>
            {detail ? <DiffStats additions={detail.additions} deletions={detail.deletions} /> : null}
          </div>
        </div>

        <div className="mt-5">
          <UnderlineTabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "description", label: "Description" },
              { value: "changes", label: "Changes", count: detail?.files.length },
              { value: "commits", label: "Commits" },
              { value: "reviews", label: "Reviews", count: reviewCount },
              { value: "checks", label: "Checks", icon: verdict?.icon, tone: verdict?.tone },
            ]}
          />
        </div>

        <div className="mt-4">
          {error !== null && detail === null ? (
            <EmptyState icon="Info" title={ERROR_COPY[error][0]} body={ERROR_COPY[error][1]}>
              {error !== "rateLimited" ? <EmptyAction label="Try again" onClick={() => void load(true)} /> : null}
              <EmptyAction label="Open on GitHub" onClick={() => navigate.openUrl(url)} />
            </EmptyState>
          ) : detail === null ? (
            <div aria-busy className="space-y-3">
              <div className="h-40 animate-pulse rounded-lg border border-border" />
              <div className="h-24 animate-pulse rounded-lg border border-border" />
            </div>
          ) : tab === "description" ? (
            <div className="space-y-4">
              <div className="px-2 text-sm">
                {detail.body.trim() === "" ? <span className="text-muted-foreground">No description provided.</span> : <Markdown content={detail.body} />}
              </div>
              <MergeBox
                detail={detail}
                busy={busy}
                onReady={() => void mutate("ready", () => rpc.call("pr_ready", { url }), "Marked as ready")}
                onMerge={(method) => {
                  if (!window.confirm(`Merge #${number} into ${detail.baseRefName}? This happens on GitHub right away.`)) return;
                  void mutate("merge", () => rpc.call("pr_merge", { url, method }), "Merged");
                }}
                onState={(next) => {
                  if (next === "close" && !window.confirm(`Close #${number} without merging?`)) return;
                  void mutate(next, () => rpc.call("pr_set_state", { url, state: next }), next === "close" ? "Closed" : "Reopened");
                }}
              />
            </div>
          ) : tab === "changes" ? (
            <Code detail={detail} diff={diff} error={diffError} onRetry={() => void loadDiff(true)} />
          ) : tab === "commits" ? (
            <Commits url={url} />
          ) : tab === "reviews" ? (
            <div className="space-y-3">
              <ReviewsSummary detail={detail} />
              <Activity detail={detail} now={now} onPosted={() => void load(true)} />
            </div>
          ) : (
            <Checks detail={detail} />
          )}
        </div>
      </div>
    </div>
  );
}

function checkRank(check: PullRequestCheck): number {
  const tone = statusStyle(checkStatus(check)).tone;
  return tone === "negative" ? 0 : tone === "warning" ? 1 : tone === "neutral" ? 2 : 3;
}

function CheckRow({ check }: { check: PullRequestCheck }) {
  const navigate = useBbNavigate();
  const style = statusStyle(checkStatus(check) || "PENDING");
  const link = check.detailsUrl || check.targetUrl;
  const name = check.name || check.context || "Unnamed check";
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 py-2 text-[13px]">
      <Icon name={style.icon} className={cn("size-3.5 shrink-0", TONE_TEXT[style.tone])} />
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      <span className="text-[11px] text-muted-foreground">{style.label}</span>
      {link ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={`Open ${name}`}
          onClick={() => navigate.openUrl(link)}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function Code({
  detail,
  diff,
  error,
  onRetry,
}: {
  detail: PullRequestDetail;
  diff: DiffFile[] | null;
  error: PullRequestError | null;
  onRetry: () => void;
}) {
  const [view, setView] = useState<"unified" | "split">("unified");
  const [closed, setClosed] = useState<string[]>([]);
  const stats = useMemo(() => new Map(detail.files.map((f) => [f.path, f])), [detail.files]);
  if (error !== null) {
    return (
      <EmptyState icon="Info" title="Couldn’t load the diff" body={ERROR_COPY[error][1]}>
        <EmptyAction label="Retry diff" onClick={onRetry} />
      </EmptyState>
    );
  }
  if (diff === null) {
    return <div aria-busy className="h-64 animate-pulse rounded-xl border border-border bg-surface-raised" />;
  }
  if (diff.length === 0) {
    return <EmptyState icon="Code" title="No changes" body="This pull request has no file changes." />;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {diff.length} file{diff.length === 1 ? "" : "s"} changed
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setClosed(closed.length === diff.length ? [] : diff.map((f) => f.path))}
        >
          {closed.length === diff.length ? "Expand all" : "Collapse all"}
        </Button>
        <Segmented
          label="Diff layout"
          value={view}
          onChange={setView}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
      </div>
      {diff.map((file) => {
        const isClosed = closed.includes(file.path);
        const stat = stats.get(file.path);
        return (
          <section key={file.path} className="overflow-hidden rounded-xl border border-border bg-surface-raised">
            <button
              type="button"
              aria-expanded={!isClosed}
              onClick={() =>
                setClosed((c) => (isClosed ? c.filter((p) => p !== file.path) : [...c, file.path]))
              }
              className="flex w-full cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left font-mono text-xs hover:bg-state-hover"
            >
              <Icon name={isClosed ? "ChevronRight" : "ChevronDown"} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {file.path}
              </span>
              {stat ? <DiffStats additions={stat.additions} deletions={stat.deletions} /> : null}
            </button>
            {isClosed ? null : <Diff patch={file.patch} path={file.path} view={view} />}
          </section>
        );
      })}
    </div>
  );
}

type ActivityEntry =
  | { kind: "comment"; at: string; comment: PullRequestComment }
  | { kind: "review"; at: string; comment: PullRequestComment }
  | { kind: "thread"; at: string; thread: NonNullable<PullRequestDetail["reviewThreads"]>[number] };

function Activity({ detail, now, onPosted }: { detail: PullRequestDetail; now: number; onPosted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const draftKey = `bb-pr-draft:${detail.url}`;
  const [draft, setDraft] = useState(() => window.localStorage.getItem(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (draft === "") window.localStorage.removeItem(draftKey);
    else window.localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);

  const entries = useMemo(() => {
    const list: ActivityEntry[] = [
      ...detail.comments.map((comment) => ({ kind: "comment" as const, at: comment.createdAt, comment })),
      ...detail.reviews.map((comment) => ({ kind: "review" as const, at: comment.createdAt, comment })),
      ...(detail.reviewThreads ?? []).map((thread) => ({
        kind: "thread" as const,
        at: thread.comments[0]?.createdAt ?? "",
        thread,
      })),
    ];
    return list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [detail]);

  const send = async () => {
    const body = draft.trim();
    if (body === "" || sending) return;
    setSending(true);
    setSendError(null);
    const result = await rpc.call("comment", { url: detail.url, body });
    setSending(false);
    if (result.ok) {
      setDraft("");
      toast("Comment posted");
      onPosted();
    } else {
      // Never retried automatically: a write may have landed.
      setSendError(`${ERROR_COPY[result.error][0]}. Check GitHub before sending again.`);
    }
  };

  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {detail.reviewThreads !== null ? "No activity yet" : "No conversation yet"}
        </div>
      ) : (
        entries.map((entry) =>
          entry.kind === "thread" ? (
            <section key={entry.thread.id} className="overflow-hidden rounded-xl border border-border bg-surface-raised">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
                <Icon name="FileDiff" className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {entry.thread.path}
                  {entry.thread.line ?? entry.thread.originalLine
                    ? `:${entry.thread.line ?? entry.thread.originalLine}`
                    : ""}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px]",
                    entry.thread.isResolved
                      ? "bg-muted-foreground/10 text-muted-foreground"
                      : "bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] text-[var(--attention)]",
                  )}
                >
                  {entry.thread.isResolved ? "Resolved" : "Unresolved"}
                </span>
                {entry.thread.isOutdated ? (
                  <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Outdated
                  </span>
                ) : null}
              </div>
              <div className="divide-y divide-border">
                {entry.thread.comments.map((comment) => (
                  <CommentBody key={comment.id} comment={comment} now={now} reply={comment.replyTo !== null} />
                ))}
              </div>
            </section>
          ) : (
            <section key={entry.comment.id || entry.at} className="overflow-hidden rounded-xl border border-border bg-surface-raised">
              <CommentBody comment={entry.comment} now={now} review={entry.kind === "review"} />
            </section>
          ),
        )
      )}

      <section className="rounded-xl border border-border bg-surface-raised p-3">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Leave a comment"
          aria-label="Comment"
          rows={3}
          className="resize-y text-sm"
        />
        {sendError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {sendError}
          </p>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-muted-foreground">
            Posts to GitHub as {detail.viewerLogin ?? "your gh account"}. Ctrl+Enter to send.
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate.openUrl(detail.url)}>
            Open on GitHub
          </Button>
          <Button size="sm" disabled={sending || draft.trim() === ""} onClick={() => void send()}>
            {sending ? "Sending…" : "Comment"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function CommentBody({
  comment,
  now,
  review,
  reply,
}: {
  comment: PullRequestComment;
  now: number;
  review?: boolean;
  reply?: boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <div className={cn("px-4 py-3", reply && "pl-10")}>
      <div className="flex items-center gap-2 text-xs">
        <Avatar login={comment.author} size={18} />
        <span className="font-medium">{comment.author || "Deleted account"}</span>
        {comment.viewerDidAuthor ? (
          <span className="rounded bg-muted-foreground/10 px-1.5 text-[10px] text-muted-foreground">You</span>
        ) : null}
        {review && comment.state && comment.state !== "COMMENTED" ? <StatusChip raw={comment.state} /> : null}
        {reply ? <span className="text-[11px] text-muted-foreground">Reply</span> : null}
        <span className="flex-1" />
        {comment.createdAt ? (
          <span className="text-[11px] text-muted-foreground" title={new Date(comment.createdAt).toLocaleString()}>
            {relativeTime(comment.createdAt, now)}
          </span>
        ) : null}
        {comment.url ? (
          <button
            type="button"
            className="cursor-pointer text-muted-foreground hover:text-foreground"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            onClick={() => navigate.openUrl(comment.url)}
          >
            <Icon name="ExternalLink" className="size-3" />
          </button>
        ) : null}
      </div>
      {comment.body.trim() !== "" ? (
        <div className="mt-2 pl-[26px] text-sm">
          <Markdown content={comment.body} />
        </div>
      ) : null}
    </div>
  );
}
