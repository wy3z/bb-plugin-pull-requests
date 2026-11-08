import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard, Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ChangeRequestCiState } from "@wy3z/bb-suite/change-requests";
import { Icon, type IconName } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/model";
import { FAILURE_TITLE, refreshNotice, type ChangeRequestFailure } from "@/lib/change-request-notice";
import type { MergeRequestDetail, MergeRequestDetailResult } from "@/lib/providers/gitlab";
import type { rpcContract } from "../../server";
import { EmptyAction, EmptyState, useNow } from "./common";

export interface GitLabTabParams {
  provider: "gitlab";
  url: string;
  connection: string;
}

const MR_URL_RE = /^https:\/\/[^\s/?#]+(?:\/[^\s?#]+)?\/-\/merge_requests\/([1-9]\d{0,9})$/;
const CONNECTION_RE = /^[a-z]+:[A-Za-z0-9_-]{1,100}$/;

export function mergeRequestNumber(url: string): number | null {
  const match = MR_URL_RE.exec(url);
  return match ? Number(match[1]) : null;
}

export function isMergeRequestUrl(url: string): boolean {
  return mergeRequestNumber(url) !== null;
}

export function gitlabTabParams(url: string, connection: string): GitLabTabParams | null {
  return isMergeRequestUrl(url) && CONNECTION_RE.test(connection) ? { provider: "gitlab", url, connection } : null;
}

export function parseGitLabTabParams(params: unknown): GitLabTabParams | null {
  if (typeof params !== "object" || params === null) return null;
  const { provider, url, connection } = params as Record<string, unknown>;
  if (provider !== "gitlab" || typeof url !== "string" || typeof connection !== "string") return null;
  return gitlabTabParams(url, connection);
}

export function mergeRequestTabTitle(url: string): string {
  return `MR !${mergeRequestNumber(url) ?? "?"}`;
}

const connections = new Map<string, string>();

export function rememberConnection(url: string, connection: string): void {
  connections.set(url, connection);
  while (connections.size > 200) connections.delete(connections.keys().next().value as string);
}

export function rememberedGitLabTab(url: string | undefined): GitLabTabParams | null {
  if (!url) return null;
  const connection = connections.get(url);
  return connection ? gitlabTabParams(url, connection) : null;
}

export function mergeRequestPagePath(params: GitLabTabParams): string {
  return `mr/${encodeURIComponent(params.url)}/${encodeURIComponent(params.connection)}`;
}

export function parseMergeRequestPagePath(segments: readonly string[]): GitLabTabParams | null {
  if (segments[0] !== "mr" || segments.length !== 3) return null;
  return gitlabTabParams(segments[1]!, segments[2]!);
}

const CI_COPY: Record<ChangeRequestCiState, { label: string; icon: IconName; tone: string }> = {
  none: { label: "No pipeline", icon: "Circle", tone: "text-[color:var(--bbs-text-tertiary)]" },
  pending: { label: "Pipeline running", icon: "Clock", tone: "text-[var(--attention)]" },
  passed: { label: "Pipeline passed", icon: "CircleCheck", tone: "text-[var(--success)]" },
  failed: { label: "Pipeline failed", icon: "CircleX", tone: "text-[var(--destructive-text)]" },
  canceled: { label: "Pipeline canceled", icon: "CircleX", tone: "text-[color:var(--bbs-text-tertiary)]" },
  skipped: { label: "Pipeline skipped", icon: "Circle", tone: "text-[color:var(--bbs-text-tertiary)]" },
  manual: { label: "Pipeline waiting for a manual job", icon: "Clock", tone: "text-[var(--attention)]" },
  unknown: { label: "Pipeline status unknown", icon: "Info", tone: "text-[color:var(--bbs-text-tertiary)]" },
};

const STATE_CHIP: Record<MergeRequestDetail["state"], { label: string; icon: IconName; className: string }> = {
  open: { label: "Open", icon: "GitPullRequest", className: "bg-[color-mix(in_oklab,var(--success)_10%,transparent)] [&>svg]:text-[var(--success)]" },
  draft: { label: "Draft", icon: "FileText", className: "bg-muted-foreground/10 [&>svg]:text-[color:var(--bbs-text-tertiary)]" },
  merged: { label: "Merged", icon: "GitMerge", className: "bg-[color-mix(in_oklab,var(--color-purple-400)_10%,transparent)] [&>svg]:text-[var(--color-purple-400)]" },
  closed: { label: "Closed", icon: "CircleX", className: "bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)] [&>svg]:text-[var(--destructive-text)]" },
};

function StateChip({ state }: { state: MergeRequestDetail["state"] }) {
  const chip = STATE_CHIP[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-[3px] text-xs", chip.className)}>
      <Icon name={chip.icon} className="size-3.5" />
      {chip.label}
    </span>
  );
}

export function MergeRequestPage({
  params,
  layout = "page",
}: {
  params: GitLabTabParams;
  layout?: "page" | "panel";
}) {
  const { url, connection } = params;
  const number = mergeRequestNumber(url);
  const inPanel = layout === "panel";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow();
  const [detail, setDetail] = useState<MergeRequestDetail | null>(null);
  const [failure, setFailure] = useState<Exclude<MergeRequestDetailResult, { ok: true }> | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const id = ++generation.current;
      setLoading(true);
      let result: MergeRequestDetailResult;
      try {
        result = await rpc.call("change_request_detail", { url, connection, refresh });
      } catch (error) {
        result = { ok: false, reason: "unknown", message: error instanceof Error ? error.message : "The request failed." };
      }
      if (id !== generation.current) return;
      setLoading(false);
      if (result.ok) {
        setDetail(result.value);
        setFailure(null);
      } else setFailure(result);
    },
    [rpc, url, connection],
  );

  useEffect(() => {
    setDetail(null);
    setFailure(null);
    void load(false);
  }, [load]);

  const copyUrl = () =>
    void experimental_copyToClipboard({ text: url }).then((ok) => (ok ? toast("Copied MR URL") : toast.error("Couldn’t copy the link")));

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full", inPanel ? "px-3 pb-6 pt-2" : "max-w-[860px] px-4 pb-10 pt-4 md:px-10")}>
        <div className="bb-pr-header flex min-h-8 items-center gap-2 px-2">
          {detail ? <StateChip state={detail.state} /> : null}
          {detail ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-[color:var(--bbs-text-tertiary)]">
              <code className="truncate font-mono" title={detail.sourceBranch}>{detail.sourceBranch}</code>
              <Icon name="ArrowRight" className="size-3 shrink-0" />
              <code className="shrink-0 font-mono">{detail.targetBranch}</code>
            </span>
          ) : null}
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 shrink-0 text-[color:var(--bbs-text-tertiary)]" aria-label="More">
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {inPanel ? (
                <DropdownMenuItem onSelect={() => navigate.toPluginPanel("pull-requests", { subPath: mergeRequestPagePath(params) })}>
                  <Icon name="Maximize2" className="size-3.5" />
                  Open as page
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => navigate.toPluginPanel("pull-requests", { subPath: "" })}>
                  <Icon name="ArrowLeft" className="size-3.5" />
                  Pull requests
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => navigate.openUrl(url)}>
                <Icon name="ExternalLink" className="size-3.5" />
                Open on GitLab
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={copyUrl}>
                <Icon name="Link" className="size-3.5" />
                Copy MR URL
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={loading} onSelect={() => void load(true)}>
                <Icon name="ArrowReloadHorizontal" className="size-3.5" />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <MergeRequestBody
          url={url}
          number={number}
          detail={detail}
          failure={failure}
          loading={loading}
          now={now}
          onRefresh={() => void load(true)}
          onOpenUrl={(target) => navigate.openUrl(target)}
        />
      </div>
    </div>
  );
}

export interface MergeRequestBodyProps {
  url: string;
  number: number | null;
  detail: MergeRequestDetail | null;
  failure: ChangeRequestFailure | null;
  loading: boolean;
  now: number;
  onRefresh: () => void;
  onOpenUrl: (target: string) => void;
}

export function MergeRequestBody({ url, number, detail, failure, loading, now, onRefresh, onOpenUrl }: MergeRequestBodyProps) {
  const ci = detail ? CI_COPY[detail.ci] : null;
  const ciLabel = detail === null ? "" : detail.ci === "unknown" && detail.ciReason ? `CI status unavailable (${detail.ciReason})` : CI_COPY[detail.ci].label;
  const notice = refreshNotice(failure, detail, now);

  return (
    <>
      <div className="mt-2">
        <h1 className="px-2 text-[length:var(--bbs-text-display)] font-medium">{detail ? detail.title : `Merge request !${number ?? "?"}`}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-[color:var(--bbs-text-tertiary)]">
          {detail?.author ? <span>{detail.author}</span> : null}
          <span>{detail ? `${detail.identity.projectPath}!${detail.identity.number}` : `!${number ?? "?"}`}</span>
          {detail?.updatedAt ? <span>Updated {relativeTime(detail.updatedAt, now)}</span> : null}
        </div>
      </div>

      <div className="mt-4">
        {failure !== null && detail === null ? (
          <EmptyState icon="Info" title={FAILURE_TITLE[failure.reason as keyof typeof FAILURE_TITLE] ?? "Couldn’t load this merge request"} body={failure.message}>
            {failure.reason !== "rateLimited" ? <EmptyAction label="Try again" onClick={onRefresh} /> : null}
            <EmptyAction label="Open on GitLab" onClick={() => onOpenUrl(url)} />
          </EmptyState>
        ) : detail === null ? (
          <div aria-busy className="space-y-3">
            <div className="h-24 animate-pulse rounded-lg border border-border" />
          </div>
        ) : (
          <div className="space-y-4">
            {notice !== null ? (
              <div role="status" className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs">
                <div className="flex items-center gap-2 font-medium text-[var(--attention)]">
                  <Icon name="AlertTriangle" className="size-4 shrink-0" />
                  {notice.title}
                </div>
                <p className="mt-1 text-[color:var(--bbs-text-tertiary)]">{notice.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[color:var(--bbs-text-tertiary)]">
                  <span>{notice.freshness}</span>
                  {failure !== null && failure.reason !== "rateLimited" ? (
                    <button type="button" className="cursor-pointer underline" disabled={loading} onClick={onRefresh}>
                      Refresh
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {ci ? (
              <div className="flex items-center gap-2 px-2 text-[length:var(--bbs-text-row)]">
                <Icon name={ci.icon} className={cn("size-4", ci.tone)} />
                {detail.pipelineUrl ? (
                  <button type="button" className="cursor-pointer font-medium hover:underline" onClick={() => onOpenUrl(detail.pipelineUrl!)}>
                    {ciLabel}
                  </button>
                ) : (
                  <span className="font-medium">{ciLabel}</span>
                )}
                <span className="flex-1" />
                {detail.headSha ? <code className="font-mono text-[length:var(--bbs-text-meta)] text-[color:var(--bbs-text-tertiary)]">{detail.headSha.slice(0, 8)}</code> : null}
              </div>
            ) : null}
            <div className="px-2 text-sm">
              {detail.description.trim() === "" ? (
                <span className="text-[color:var(--bbs-text-tertiary)]">No description provided.</span>
              ) : (
                <Markdown content={detail.description} />
              )}
            </div>
            <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-[color:var(--bbs-text-tertiary)]">
              Changes, commits, discussions and approvals for GitLab aren’t shown here yet.{" "}
              <button type="button" className="cursor-pointer underline" onClick={() => onOpenUrl(url)}>
                Open on GitLab
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
