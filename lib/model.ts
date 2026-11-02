// Pull request model and assessment, ported from Zeron
// (crates/proto/src/change_request_assessment.rs and entities.rs, MIT).
// One assessment drives board rows, the detail page and agent handoffs.
// Missing metadata never implies that a pull request is ready or its checks
// passed.

export type CiState =
  | "noChecks"
  | "pending"
  | "passed"
  | "skipped"
  | "failed"
  | "unknown";

export interface PullRequestCi {
  state: CiState;
  totalCount: number;
}

export type ReviewDecision =
  | "approved"
  | "changesRequested"
  | "reviewRequired"
  | "unknown";

export type Mergeability = "mergeable" | "conflicting" | "unknown";

export type PullRequestFilter = "authored" | "reviewing" | "all";

export interface PullRequestListItem {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headRefOid: string;
  ci: PullRequestCi;
  /** null: the viewer relationship is unavailable, not false. */
  viewerDidAuthor: boolean | null;
  viewerReviewRequested: boolean | null;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  mergeability: Mergeability;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestPage {
  items: PullRequestListItem[];
  nextCursor: string | null;
  totalCount: number | null;
  fetchedAt: string;
}

export interface PullRequestCheck {
  name: string;
  context: string;
  status: string;
  conclusion: string;
  state: string;
  detailsUrl: string;
  targetUrl: string;
}

export interface PullRequestComment {
  id: string;
  url: string;
  author: string;
  body: string;
  createdAt: string;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED… */
  state: string;
  viewerDidAuthor: boolean;
  replyTo: string | null;
}

export interface PullRequestReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: PullRequestComment[];
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PullRequestDetail {
  url: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: ReviewDecision;
  mergeability: Mergeability;
  additions: number;
  deletions: number;
  ci: PullRequestCi;
  viewerDidAuthor: boolean | null;
  viewerReviewRequested: boolean | null;
  viewerLogin: string | null;
  checks: PullRequestCheck[];
  comments: PullRequestComment[];
  reviews: PullRequestComment[];
  /** null: unavailable, not "no feedback". */
  reviewThreads: PullRequestReviewThread[] | null;
  files: PullRequestFile[];
  fetchedAt: string;
}

export const CI_LABEL: Record<CiState, string> = {
  unknown: "CI unavailable",
  noChecks: "No checks reported",
  pending: "CI pending",
  passed: "CI passed",
  skipped: "CI skipped",
  failed: "CI failing",
};

export function validHeadOid(head: string): boolean {
  return /^[0-9a-f]{40}$/i.test(head);
}

export function checkStatus(check: PullRequestCheck): string {
  return (
    [check.conclusion, check.state, check.status].find((v) => v !== "") ?? ""
  ).toUpperCase();
}

const FAILED_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
  "STARTUP_FAILURE",
]);

export function checkFailed(status: string): boolean {
  return FAILED_STATES.has(status);
}

export function ciFromChecks(checks: PullRequestCheck[]): PullRequestCi {
  const statuses = checks.map(checkStatus);
  let state: CiState;
  if (checks.length === 0) state = "noChecks";
  else if (statuses.some(checkFailed)) state = "failed";
  else if (statuses.some((s) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)))
    state = "pending";
  else if (statuses.every((s) => s === "NEUTRAL" || s === "SKIPPED"))
    state = "skipped";
  else state = "passed";
  return { state, totalCount: checks.length };
}

export type Blocker = "failingCi" | "changesRequested" | "mergeConflicts";
export const BLOCKER_LABEL: Record<Blocker, string> = {
  failingCi: "CI failing",
  changesRequested: "Changes requested",
  mergeConflicts: "Merge conflicts",
};

export type Missing =
  | "headCommit"
  | "ci"
  | "mergeability"
  | "reviewDecision"
  | "viewerRelationship"
  | "checkDetails";
export const MISSING_LABEL: Record<Missing, string> = {
  headCommit: "Current commit unavailable",
  ci: "CI unavailable",
  mergeability: "Mergeability unknown",
  reviewDecision: "No review decision reported",
  viewerRelationship: "Your relationship to this PR is unavailable",
  checkDetails: "Some check details are unavailable",
};

export type SuggestedAction =
  | "fixChecks"
  | "addressFeedback"
  | "resolveConflicts"
  | "review"
  | "refreshMetadata";
export const ACTION_LABEL: Record<SuggestedAction, string> = {
  fixChecks: "Fix failing checks",
  addressFeedback: "Address requested changes",
  resolveConflicts: "Resolve merge conflicts",
  review: "Review pull request",
  refreshMetadata: "Refresh metadata",
};

export type Attention = "reviewRequested" | "feedbackOnAuthored" | "failingCi";
export const ATTENTION_LABEL: Record<Attention, string> = {
  reviewRequested: "Your review requested",
  feedbackOnAuthored: "Your PR needs changes",
  failingCi: "Your CI needs attention",
};

export interface Assessment {
  blockers: Blocker[];
  missing: Missing[];
  actions: SuggestedAction[];
  attention: Attention[];
  ci: PullRequestCi;
}

interface Facts {
  head: string;
  ci: PullRequestCi;
  open: boolean;
  draft: boolean;
  mergeability: Mergeability;
  review: ReviewDecision;
  authored: boolean | null;
  requested: boolean | null;
  checkDetailsMissing: boolean;
}

export function factsFromItem(item: PullRequestListItem): Facts {
  return {
    head: item.headRefOid,
    ci: item.ci,
    open: true,
    draft: item.isDraft,
    mergeability: item.mergeability,
    review: item.reviewDecision,
    authored: item.viewerDidAuthor,
    requested: item.viewerReviewRequested,
    checkDetailsMissing: false,
  };
}

export function factsFromDetail(detail: PullRequestDetail): Facts {
  const ci =
    detail.ci.state === "unknown" && detail.checks.length > 0
      ? ciFromChecks(detail.checks)
      : detail.ci;
  return {
    head: detail.headRefOid,
    ci,
    open: !["CLOSED", "MERGED"].includes(detail.state.toUpperCase()),
    draft: detail.isDraft,
    mergeability: detail.mergeability,
    review: detail.reviewDecision,
    authored: detail.viewerDidAuthor,
    requested: detail.viewerReviewRequested,
    checkDetailsMissing:
      detail.ci.totalCount > detail.checks.length ||
      (detail.ci.state === "failed" &&
        !detail.checks.some((c) => checkFailed(checkStatus(c)))),
  };
}

export function assess(facts: Facts): Assessment {
  const result: Assessment = {
    blockers: [],
    missing: [],
    actions: [],
    attention: [],
    ci: facts.ci,
  };
  if (!validHeadOid(facts.head)) result.missing.push("headCommit");
  if (facts.ci.state === "unknown") result.missing.push("ci");
  if (facts.mergeability === "unknown") result.missing.push("mergeability");
  if (facts.review === "unknown") result.missing.push("reviewDecision");
  if (facts.authored === null || facts.requested === null)
    result.missing.push("viewerRelationship");
  if (facts.checkDetailsMissing) result.missing.push("checkDetails");
  if (facts.open) {
    if (facts.ci.state === "failed") {
      result.blockers.push("failingCi");
      result.actions.push("fixChecks");
      if (facts.authored === true || facts.requested === true)
        result.attention.push("failingCi");
    }
    if (facts.review === "changesRequested") {
      result.blockers.push("changesRequested");
      result.actions.push("addressFeedback");
      if (facts.authored === true) result.attention.push("feedbackOnAuthored");
    }
    if (facts.mergeability === "conflicting") {
      result.blockers.push("mergeConflicts");
      result.actions.push("resolveConflicts");
    }
    if (facts.requested === true && !facts.draft)
      result.attention.unshift("reviewRequested");
  }
  if (result.missing.length > 0) result.actions.push("refreshMetadata");
  if (facts.open && !facts.draft) result.actions.push("review");
  return result;
}

export type PullRequestGroup = "attention" | "review" | "approved" | "drafts";
export const GROUPS: readonly PullRequestGroup[] = [
  "attention",
  "review",
  "approved",
  "drafts",
];
export const GROUP_LABEL: Record<PullRequestGroup, string> = {
  attention: "Needs attention",
  review: "Awaiting review",
  approved: "Approved",
  drafts: "Drafts",
};

export function requestGroup(item: PullRequestListItem): PullRequestGroup {
  const a = assess(factsFromItem(item));
  if (item.isDraft) return "drafts";
  if (a.blockers.length > 0 || a.attention.length > 0) return "attention";
  if (item.reviewDecision === "approved") return "approved";
  return "review";
}

/** "Needs you": the viewer has something to do on it. */
export function needsYou(item: PullRequestListItem): boolean {
  return assess(factsFromItem(item)).attention.length > 0;
}

/** Full status text, used for search and accessible labels. */
export function statusDescription(item: PullRequestListItem): string {
  const a = assess(factsFromItem(item));
  const labels = [item.isDraft ? "Draft" : "Open"];
  labels.push(...a.blockers.map((b) => BLOCKER_LABEL[b]));
  if (item.reviewDecision === "approved") labels.push("Approved");
  labels.push(
    ...a.attention.filter((r) => r !== "failingCi").map((r) => ATTENTION_LABEL[r]),
  );
  return labels.join(" · ");
}

/** The row's status line; CI has its own label beside it. */
export function rowStatus(item: PullRequestListItem): string {
  const a = assess(factsFromItem(item));
  const labels = a.blockers
    .filter((b) => b !== "failingCi")
    .map((b) => BLOCKER_LABEL[b]);
  if (item.isDraft) labels.unshift("Draft");
  if (item.reviewDecision === "approved") labels.push("Approved");
  labels.push(
    ...a.attention.filter((r) => r !== "failingCi").map((r) => ATTENTION_LABEL[r]),
  );
  return labels.join(" · ");
}

export function matchesQuery(item: PullRequestListItem, query: string): boolean {
  const text =
    `${item.title} ${item.repository} #${item.number} ${statusDescription(item)} ${item.author}`.toLowerCase();
  return query
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((w) => text.includes(w.toLowerCase()));
}

export type SortField = "updated" | "opened" | "changes";
export type SortDirection = "asc" | "desc";
export interface Sort {
  field: SortField;
  direction: SortDirection;
}
export const SORT_OPTIONS: readonly { sort: Sort; label: string }[] = [
  { sort: { field: "updated", direction: "desc" }, label: "Recently updated" },
  { sort: { field: "updated", direction: "asc" }, label: "Least recently updated" },
  { sort: { field: "opened", direction: "desc" }, label: "Newest first" },
  { sort: { field: "opened", direction: "asc" }, label: "Oldest first" },
  { sort: { field: "changes", direction: "desc" }, label: "Largest changes" },
  { sort: { field: "changes", direction: "asc" }, label: "Smallest changes" },
];

export function sortPullRequests(
  items: PullRequestListItem[],
  sort: Sort,
): PullRequestListItem[] {
  const key = (item: PullRequestListItem): number =>
    sort.field === "changes"
      ? item.additions + item.deletions
      : Date.parse(sort.field === "opened" ? item.createdAt : item.updatedAt);
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...items].sort(
    (a, b) =>
      sign * (key(a) - key(b)) ||
      a.repository.localeCompare(b.repository) ||
      a.number - b.number,
  );
}

/** Stable across remote spellings; stars are local preferences. */
export function starKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return url.replace(/\/+$/, "").toLowerCase();
  }
}

export function relativeTime(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return "just now";
  const [amount, unit] =
    seconds < 3_600
      ? [Math.floor(seconds / 60), "minute"]
      : seconds < 86_400
        ? [Math.floor(seconds / 3_600), "hour"]
        : seconds < 604_800
          ? [Math.floor(seconds / 86_400), "day"]
          : seconds < 2_592_000
            ? [Math.floor(seconds / 604_800), "week"]
            : seconds < 31_536_000
              ? [Math.floor(seconds / 2_592_000), "month"]
              : [Math.floor(seconds / 31_536_000), "year"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

export function compactRelativeTime(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w ago`;
  return `${Math.floor(seconds / 2_592_000)}mo ago`;
}

export function compactCount(value: number): string {
  const one = (n: number, unit: string) => {
    const tenths = Math.floor(n * 10) % 10;
    return tenths === 0 ? `${Math.floor(n)}${unit}` : `${Math.floor(n)}.${tenths}${unit}`;
  };
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return one(value / 1_000, "k");
  return one(value / 1_000_000, "m");
}

export function humanize(raw: string): string {
  const text = raw.replace(/_/g, " ").toLowerCase();
  return text === "" ? "Not reported" : text[0]!.toUpperCase() + text.slice(1);
}

/** `owner/name` from a GitHub pull request URL. */
export function repositoryOf(url: string): string {
  return url.split("/").slice(3, 5).join("/");
}

export function validRepository(repository: string): boolean {
  const parts = repository.split("/");
  return (
    parts.length === 2 &&
    parts.every((p) => p !== "" && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p))
  );
}

/** `owner/name` from a GitHub remote URL, or null for any other host. */
export function repositoryFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      remote.trim(),
    );
  if (!match) return null;
  const repository = `${match[1]}/${match[2]}`;
  return validRepository(repository) ? repository : null;
}
