// Cursor's two pull request status models.
//
// - Lifecycle (pr-lifecycle-presentation.js): open, draft, merged, closed.
//   Used by links in messages, their hover cards, and tab icons.
// - Tray status (project-pr-groups.js, Sz_): what the composer tray shows per
//   row, from state, draft, mergeability, CI and review.
import type { IconName } from "@/components/ui/icon";
import type { PullRequestSummary } from "../server";

export type Lifecycle = "open" | "draft" | "merged" | "closed";

export function lifecycle(summary: PullRequestSummary): Lifecycle {
  const state = summary.state.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return summary.isDraft ? "draft" : "open";
}

export const LIFECYCLE: Record<Lifecycle, { icon: IconName; label: string }> = {
  open: { icon: "GitPullRequest", label: "Open" },
  draft: { icon: "GitPullRequestDraft", label: "Draft" },
  merged: { icon: "GitMerge", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", label: "Closed" },
};

export type TrayStatus = "merged" | "closed" | "draft" | "conflict" | "ci-failing" | "ready-to-merge" | "needs-review";

/** Cursor's order: lifecycle, then conflicts, CI, and whether it can merge. */
export function trayStatus(summary: PullRequestSummary): TrayStatus {
  const state = lifecycle(summary);
  if (state === "merged" || state === "closed" || state === "draft") return state;
  if (summary.mergeability === "conflicting") return "conflict";
  if (summary.ci.state === "failed") return "ci-failing";
  const reviewed =
    summary.reviewDecision === "approved" ||
    (summary.reviewDecision === "unknown" && summary.mergeability === "mergeable");
  return summary.ci.state === "passed" && reviewed ? "ready-to-merge" : "needs-review";
}

/** Icon, colour (a `data-tone` in app.css) and the row's status word; none for finished ones. */
export const TRAY_STATUS: Record<TrayStatus, { icon: IconName; tone: string; label: string | null }> = {
  draft: { icon: "GitPullRequestDraft", tone: "tertiary", label: "Draft" },
  conflict: { icon: "DiffConflict", tone: "orange", label: "Conflicts" },
  "ready-to-merge": { icon: "GitPullRequestArrow", tone: "green", label: "Ready" },
  "ci-failing": { icon: "X", tone: "red", label: "CI Failing" },
  "needs-review": { icon: "Search", tone: "yellow", label: "Waiting for Reviewers" },
  merged: { icon: "GitMerge", tone: "purple", label: null },
  closed: { icon: "GitPullRequestClosed", tone: "red", label: null },
};

export function isDone(summary: PullRequestSummary | undefined): boolean {
  if (!summary) return false;
  const state = lifecycle(summary);
  return state === "merged" || state === "closed";
}
