export const OPEN_PULL_REQUEST_EVENT = "bb-pull-requests:open";

export interface OpenPullRequestDetail {
  url: string;
}

export function openPullRequestUrl(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const url = (detail as Partial<OpenPullRequestDetail>).url;
  return typeof url === "string" ? url : null;
}
