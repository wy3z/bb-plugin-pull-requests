// One pull request, ported from Zeron's crates/ui/src/pull_request_detail.rs
// (MIT): Summary (status, review, branch, changes, checks, assessment,
// description), Code (per-file diffs) and Activity (conversation, reviews,
// inline threads, and an explicit comment box).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Diff as Diff,
  Markdown,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
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
  ACTION_LABEL,
  assess,
  BLOCKER_LABEL,
  checkStatus,
  factsFromDetail,
  humanize,
  MISSING_LABEL,
  relativeTime,
  starKey,
  validHeadOid,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
} from "@/lib/model";
import { availableHandoffs, HANDOFFS, handoffPrompt } from "@/lib/handoff";
import { SubscribeButton } from "./listening";
import type { DiffFile, PullRequestError, RepositoryChoice, rpcContract } from "../../server";
import { StarButton } from "./board";
import { RepoIcon } from "@/components/project-icons/RepoIcon";
import { Avatar, DiffStats, EmptyAction, EmptyState, ERROR_COPY, Segmented, useNow } from "./common";

type Tab = "summary" | "code" | "activity";

type Tone = "neutral" | "positive" | "warning" | "negative" | "merged";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  positive: "text-green-600 dark:text-green-500",
  warning: "text-amber-600 dark:text-amber-500",
  negative: "text-red-600 dark:text-red-500",
  merged: "text-purple-600 dark:text-purple-400",
};
const TONE_BG: Record<Tone, string> = {
  neutral: "bg-muted-foreground/10",
  positive: "bg-green-500/10",
  warning: "bg-amber-500/10",
  negative: "bg-red-500/10",
  merged: "bg-purple-500/10",
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
  /** "panel" is the side-panel tab: tighter padding, no back link. */
  layout?: "page" | "panel";
  /** The thread whose side panel shows this; enables Subscribe. */
  threadId?: string;
}) {
  const url = `https://github.com/${owner}/${name}/pull/${number}`;
  const inPanel = layout === "panel";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("summary");
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<PullRequestError | null>(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffError, setDiffError] = useState<PullRequestError | null>(null);
  const [choices, setChoices] = useState<RepositoryChoice[]>([]);
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
    if (tab === "code" && diff === null && diffError === null) void loadDiff(false);
  }, [tab, diff, diffError, loadDiff]);
  useEffect(() => {
    void rpc.call("repositories").then((r) => setChoices(r.choices));
  }, [rpc]);

  const refresh = () => {
    void load(true);
    if (diff !== null || tab === "code") {
      setDiff(null);
      void loadDiff(true);
    }
  };

  const project = choices.find((c) => c.projectId !== "" && c.repository.toLowerCase() === `${owner}/${name}`.toLowerCase());
  const startHandoff = (kind: (typeof HANDOFFS)[number]["kind"]) => {
    if (!detail) return;
    navigate.toCompose({
      projectId: project?.projectId,
      initialPrompt: handoffPrompt(kind, detail),
      focusPrompt: true,
    });
  };

  const activityCount = detail
    ? detail.comments.length + detail.reviews.length + (detail.reviewThreads?.length ?? 0)
    : undefined;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto box-border w-full",
          inPanel ? "px-3 pb-6 pt-2" : "max-w-[860px] px-4 pb-10 pt-4 md:px-10",
        )}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-1">
          {inPanel ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Open as page"
              onClick={() =>
                navigate.toPluginPanel("pull-requests", { subPath: `pr/${owner}/${name}/${number}` })
              }
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
          <StarButton starred={stars.includes(starKey(url))} onToggle={() => onToggleStar(url)} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Refresh pull request"
            disabled={loading}
            onClick={refresh}
          >
            <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Copy link"
            onClick={() =>
              void experimental_copyToClipboard({ text: url }).then((ok) =>
                ok ? toast("Link copied") : toast.error("Couldn’t copy the link"),
              )
            }
          >
            <Icon name="Link" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Open on GitHub"
            onClick={() => navigate.openUrl(url)}
          >
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
        </div>

        {/* Header */}
        <div className="mt-4 px-2">
          <h1 className={cn("font-medium", inPanel ? "text-base leading-[22px]" : "text-xl leading-[26px]")}>{detail?.title ?? `Pull request #${number}`}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {detail ? (
              <span className="flex items-center gap-2">
                <Avatar login={detail.author} size={20} />
                {detail.author || "Deleted account"}
              </span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <RepoIcon icon={project?.icon} />
              {owner}/{name}
            </span>
            <span className="flex items-center gap-1.5">
              <Icon name="GitPullRequest" className="size-3.5" />
              {number}
            </span>
            {detail ? (
              <span className="flex items-center gap-1.5">
                <Icon name="Clock" className="size-3.5" />
                Loaded {relativeTime(detail.fetchedAt, now)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-5">
          <Segmented
            label="Pull request sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "summary", label: "Summary", icon: "FileText" },
              { value: "code", label: "Code", icon: "Code", count: detail?.files.length },
              { value: "activity", label: "Activity", icon: "MessageSquare", count: activityCount },
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
              <div className="h-40 animate-pulse rounded-xl border border-border bg-surface-raised" />
              <div className="h-24 animate-pulse rounded-xl border border-border bg-surface-raised" />
            </div>
          ) : tab === "summary" ? (
            <Summary detail={detail} />
          ) : tab === "code" ? (
            <Code detail={detail} diff={diff} error={diffError} onRetry={() => void loadDiff(true)} />
          ) : (
            <Activity detail={detail} now={now} onPosted={() => void load(true)} />
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ detail }: { detail: PullRequestDetail }) {
  const assessment = assess(factsFromDetail(detail));
  const ci = ciRaw(detail);
  return (
    <div className="space-y-3">
      <Card>
        <div className="divide-y divide-border">
          <Field label="Status">
            <StatusChip raw={detail.isDraft ? "DRAFT" : detail.state} />
          </Field>
          <Field label="Review">
            {detail.reviewDecision === "unknown" ? (
              <span className="text-muted-foreground">No review decision</span>
            ) : (
              <StatusChip raw={REVIEW_RAW[detail.reviewDecision]} />
            )}
          </Field>
          <Field label="Branch">
            <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{detail.headRefName}</code>
            <Icon name="ArrowRight" className="size-3 text-muted-foreground" />
            <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{detail.baseRefName}</code>
          </Field>
          <Field label="Changes">
            <DiffStats additions={detail.additions} deletions={detail.deletions} />
            <span className="text-xs text-muted-foreground">
              {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
            </span>
          </Field>
        </div>
      </Card>

      <Card
        title="Checks"
        trailing={ci ? <StatusChip raw={ci} /> : <span className="text-xs text-muted-foreground">{assessment.ci.state === "noChecks" ? "No checks reported" : "CI unavailable"}</span>}
      >
        {detail.checks.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            {assessment.ci.state === "unknown"
              ? "CI metadata is unavailable. Refresh to try again."
              : assessment.ci.state === "noChecks"
                ? "No checks reported."
                : "Check details are unavailable. Open this pull request on GitHub."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {[...detail.checks]
              .sort((a, b) => checkRank(a) - checkRank(b))
              .map((check, index) => (
                <CheckRow key={`${check.name || check.context}-${index}`} check={check} />
              ))}
          </div>
        )}
      </Card>

      <Card title="Current assessment">
        <div className="space-y-2 px-4 py-3 text-[13px]">
          <div className="flex flex-wrap gap-2">
            {assessment.blockers.length === 0 ? (
              <span className="text-muted-foreground">
                {assessment.missing.length === 0 ? "No blockers reported" : "Assessment incomplete"}
              </span>
            ) : (
              assessment.blockers.map((b) => (
                <span key={b} className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">
                  {BLOCKER_LABEL[b]}
                </span>
              ))
            )}
          </div>
          {assessment.actions[0] ? (
            <div className="text-xs text-muted-foreground">Next: {ACTION_LABEL[assessment.actions[0]]}</div>
          ) : null}
          {assessment.missing.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              {assessment.missing.map((m) => MISSING_LABEL[m]).join(" · ")}
            </div>
          ) : null}
          <div className="font-mono text-[11px] text-muted-foreground">
            {validHeadOid(detail.headRefOid) ? `Commit ${detail.headRefOid.slice(0, 7)}` : "Commit unavailable"}
          </div>
        </div>
      </Card>

      <Card title="Description">
        <div className="px-4 py-3 text-sm">
          {detail.body.trim() === "" ? (
            <span className="text-muted-foreground">No description provided.</span>
          ) : (
            <Markdown content={detail.body} />
          )}
        </div>
      </Card>
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
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-500",
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
