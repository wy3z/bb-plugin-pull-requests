import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { compactCount } from "@/lib/model";
import type { PullRequestError } from "../../server";

/** Re-render once a minute so relative times stay honest. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function Avatar({ login, size = 16 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!login || failed) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[9px] uppercase text-muted-foreground"
      >
        {login.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      alt=""
      src={`https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-muted"
      style={{ width: size, height: size }}
    />
  );
}

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      title={`${additions} additions, ${deletions} deletions`}
      className="flex items-center gap-2 font-mono text-[11px]"
    >
      <span className="text-[var(--diff-added,var(--success))]">+{compactCount(additions)}</span>
      <span className="text-[var(--diff-removed,var(--destructive-text))]">−{compactCount(deletions)}</span>
    </span>
  );
}

/** The small tinted `#27` badge Zeron draws beside the author. */
export function NumberBadge({ number, draft }: { number: number; draft: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-[3px] rounded px-1 text-[10px] font-medium",
        draft
          ? "bg-muted-foreground/10 text-muted-foreground"
          : "bg-[color-mix(in_oklab,var(--success)_10%,transparent)] text-[var(--success)]",
      )}
    >
      <Icon name={draft ? "GitPullRequestDraft" : "GitPullRequest"} className="size-2.5" />
      {number}
    </span>
  );
}

export const ERROR_COPY: Record<PullRequestError, [string, string]> = {
  cliUnavailable: [
    "GitHub CLI isn’t available on this machine",
    "Install gh and sign in to view your pull requests.",
  ],
  authentication: ["Sign in to GitHub on this machine", "Run gh auth login, then refresh this page."],
  rateLimited: [
    "GitHub’s rate limit was reached",
    "Requests are paused for 15 minutes. Your loaded results stay available.",
  ],
  network: [
    "Couldn’t load pull requests",
    "Check the repository name and your connection, then try again.",
  ],
  notFound: [
    "Repository not found",
    "It doesn’t exist, or the active gh account can’t see it. Switch accounts with gh auth switch, then try again.",
  ],
  unsupported: ["That isn’t a GitHub pull request", "Only github.com repositories are supported."],
};

export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: IconName;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="mt-16 flex flex-col items-center text-center">
      <Icon name={icon} className="mb-4 size-6 text-muted-foreground" />
      <div className="w-[420px] max-w-full text-[15px] font-semibold leading-[22px]">{title}</div>
      <div className="mt-1.5 w-[420px] max-w-full text-[13px] leading-5 text-muted-foreground">{body}</div>
      {children ? <div className="mt-4 flex gap-2">{children}</div> : null}
    </div>
  );
}

export function EmptyAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
    </Button>
  );
}

/** A segmented tab strip (Authored / Reviewing / All, Summary / Code / Activity). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: IconName; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex h-8 w-fit shrink-0 items-center gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
            value === option.value
              ? "bg-state-active text-foreground"
              : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
        >
          {option.icon ? <Icon name={option.icon} className="size-3.5" /> : null}
          {option.label}
          {option.count !== undefined ? (
            <span className="text-[10px] text-muted-foreground">{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** A pill toggle (Needs you / Starred). */
export function Chip({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
        active
          ? "bg-state-active text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5" />
      {label}
    </button>
  );
}
