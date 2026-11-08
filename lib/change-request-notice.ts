import type { MergeRequestDetail, MergeRequestDetailResult } from "./providers/gitlab";
import { relativeTime } from "./model";

export type ChangeRequestFailure = Exclude<MergeRequestDetailResult, { ok: true }>;

export const FAILURE_TITLE: Partial<Record<ChangeRequestFailure["reason"], string>> = {
  cliMissing: "glab isn’t installed",
  authentication: "glab isn’t signed in",
  forbidden: "This merge request isn’t visible",
  notFound: "Merge request not found",
  hostOffline: "The machine is offline",
  rateLimited: "GitLab is rate limiting requests",
  network: "Couldn’t reach GitLab",
  unsupportedHost: "Unknown GitLab instance",
};

export interface RefreshNotice {
  title: string;
  message: string;
  freshness: string;
}

export function refreshNotice(
  failure: ChangeRequestFailure | null,
  detail: Pick<MergeRequestDetail, "fetchedAt"> | null,
  now: number,
): RefreshNotice | null {
  if (failure === null || detail === null) return null;
  return {
    title: FAILURE_TITLE[failure.reason] ?? "Couldn’t refresh this merge request",
    message: failure.message,
    freshness: `This is what was read ${relativeTime(detail.fetchedAt, now)}.`,
  };
}
