import type { ChangeRequest, ChangeRequestRow, ChangeRequestState, ChangeRequestCiState, GitLabIdentity } from "@wy3z/bb-suite/change-requests";
import {
  gitlabIdentity,
  gitlabProjectApiPath,
  hasUnverifiedHistory,
  mergeRequestCandidate,
  mergeRequestState,
  pickSameProjectMergeRequest,
  pipelineCiState,
  type GitLabInstance,
  type MergeRequestCandidate,
} from "../change-request";
import type { GitLabFailure, GitLabHttp } from "../host-contract";

export interface GitLabTransport {
  get(path: string): Promise<GitLabHttp>;
}

const STATUS_LINE_RE = /^HTTP\/[0-9.]+\s+(\d{3})[^\r\n]*\r?\n/;

function failureForStatus(status: number): GitLabFailure {
  if (status === 401) return "authentication";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  return "network";
}

export function classifyGlabStderr(stderr: string): GitLabFailure {
  const text = stderr.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|not logged|no token|authenticat|glab auth login|invalid_token|token.*(expired|revoked)/.test(text))
    return "authentication";
  if (/\b403\b|forbidden/.test(text)) return "forbidden";
  if (/\b429\b|rate limit|too many requests/.test(text)) return "rateLimited";
  if (/\b404\b|not found/.test(text)) return "notFound";
  if (
    /no such host|dial tcp|connection refused|network is unreachable|i\/o timeout|timeout|could not resolve|temporary failure in name resolution|no route to host|connection reset|tls handshake/.test(
      text,
    )
  )
    return "offline";
  return "network";
}

export function parseGlabApiOutput(stdout: string, stderr: string, exitCode: number | null): GitLabHttp {
  const status = STATUS_LINE_RE.exec(stdout);
  if (status) {
    const code = Number(status[1]);
    const split = /\r?\n\r?\n/.exec(stdout);
    const headerText = split ? stdout.slice(0, split.index) : stdout;
    const body = split ? stdout.slice(split.index + split[0].length) : "";
    if (code < 200 || code >= 300) return { ok: false, failure: failureForStatus(code), status: code };
    let nextPage: number | null = null;
    for (const line of headerText.split(/\r?\n/).slice(1)) {
      const header = /^x-next-page:\s*(\d+)\s*$/i.exec(line);
      if (header && Number(header[1]) > 0) nextPage = Number(header[1]);
    }
    try {
      return { ok: true, status: code, nextPage, body: body.trim() === "" ? null : JSON.parse(body) };
    } catch {
      return { ok: false, failure: "network", status: code };
    }
  }
  if (exitCode === 0) {
    try {
      return { ok: true, status: 200, nextPage: null, body: JSON.parse(stdout) };
    } catch {
      return { ok: false, failure: "network", status: null };
    }
  }
  return { ok: false, failure: classifyGlabStderr(stderr), status: null };
}

export type GitLabUnavailable = Extract<ChangeRequestRow, { outcome: "unavailable" }>;

export interface UnavailableContext {
  instance: GitLabInstance;
  machine: string;
}

export function unavailableFor(failure: GitLabFailure, context: UnavailableContext): GitLabUnavailable {
  const at = context.instance.hostname;
  switch (failure) {
    case "cliMissing":
      return {
        outcome: "unavailable",
        provider: "gitlab",
        reason: "cliMissing",
        message: `glab isn't installed on ${context.machine}. Install the GitLab CLI there and run glab auth login --hostname ${at}.`,
      };
    case "authentication":
      return {
        outcome: "unavailable",
        provider: "gitlab",
        reason: "authentication",
        message: `glab on ${context.machine} isn't signed in to ${at}. Run glab auth login --hostname ${at} there.`,
      };
    case "forbidden":
    case "notFound":
      return {
        outcome: "unavailable",
        provider: "gitlab",
        reason: "forbidden",
        message: `${at} wouldn't show this project to the glab login on ${context.machine}. Check that account can read it.`,
      };
    case "rateLimited":
      return { outcome: "unavailable", provider: "gitlab", reason: "rateLimited", message: `${at} is rate limiting requests. Try again in a few minutes.` };
    case "offline":
      return { outcome: "unavailable", provider: "gitlab", reason: "network", message: `${context.machine} couldn't reach ${at}.` };
    case "network":
      return { outcome: "unavailable", provider: "gitlab", reason: "network", message: `${at} didn't answer as expected. Try again shortly.` };
  }
}

export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const MAX_PAGES = 5;
const PER_PAGE = 100;

export interface DiscoverInput {
  instance: GitLabInstance;
  projectPath: string;
  branch: string;
  connection: string;
  machine: string;
  now?: () => Date;
}

function provenanceMismatch(instance: GitLabInstance, iid: number): GitLabUnavailable {
  return {
    outcome: "unavailable",
    provider: "gitlab",
    reason: "unknown",
    message: `GitLab answered for !${iid} with a URL outside ${instance.base}. Check the GitLab instance in Pull Requests settings.`,
  };
}

export async function discoverMergeRequest(transport: GitLabTransport, input: DiscoverInput): Promise<ChangeRequestRow> {
  const context = { instance: input.instance, machine: input.machine };
  const project = gitlabProjectApiPath(input.projectPath);
  const branch = encodeQueryValue(input.branch);
  const open: MergeRequestCandidate[] = [];
  let page: number | null = 1;
  for (let read = 0; page !== null; read++) {
    if (read === MAX_PAGES) {
      return {
        outcome: "unavailable",
        provider: "gitlab",
        reason: "incomplete",
        message: `More than ${MAX_PAGES * PER_PAGE} open merge requests match the branch ${input.branch}, so BB can't tell which one is this branch's.`,
      };
    }
    const response = await transport.get(
      `${project}/merge_requests?source_branch=${branch}&state=opened&order_by=updated_at&sort=desc&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!response.ok) return unavailableFor(response.failure, context);
    if (!Array.isArray(response.body)) return unavailableFor("network", context);
    for (const raw of response.body) {
      const candidate = mergeRequestCandidate(raw);
      if (candidate) open.push(candidate);
    }
    page = response.nextPage;
  }
  const pick = pickSameProjectMergeRequest(open, input.branch);
  if (pick.kind === "ambiguous") {
    return {
      outcome: "unavailable",
      provider: "gitlab",
      reason: "ambiguous",
      candidates: pick.count,
      message: `${pick.count} open merge requests use the branch ${input.branch}. Open the one you mean from GitLab.`,
    };
  }
  if (pick.kind === "none") {
    const history = await transport.get(`${project}/merge_requests?source_branch=${branch}&state=all&order_by=updated_at&sort=desc&per_page=20&page=1`);
    if (!history.ok) return unavailableFor(history.failure, context);
    const past = Array.isArray(history.body) ? history.body.flatMap((raw) => mergeRequestCandidate(raw) ?? []) : [];
    if (hasUnverifiedHistory(past, input.branch)) {
      return {
        outcome: "unavailable",
        provider: "gitlab",
        reason: "unverified",
        message: `Only merged or closed merge requests use the branch ${input.branch}. They aren't shown because BB can't yet prove they belong to this checkout.`,
      };
    }
    return { outcome: "absent", provider: "gitlab" };
  }
  const chosen = pick.mergeRequest;
  const identity = gitlabIdentity(input.instance, chosen);
  if (identity === null) return provenanceMismatch(input.instance, chosen.iid);
  const detail = await transport.get(`${gitlabProjectApiPath(chosen.projectId)}/merge_requests/${chosen.iid}`);
  let ci: ChangeRequestCiState = "unknown";
  let state: ChangeRequestState = chosen.state;
  let title = chosen.title;
  if (detail.ok && typeof detail.body === "object" && detail.body !== null) {
    const body = detail.body as Record<string, unknown>;
    const fresh = mergeRequestCandidate(body);
    if (fresh && fresh.iid === chosen.iid && fresh.projectId === chosen.projectId) {
      state = fresh.state;
      title = fresh.title || title;
      ci = "head_pipeline" in body ? pipelineCiState(body.head_pipeline, fresh.sha) : "unknown";
    }
  } else if (!detail.ok && detail.failure === "authentication") {
    return unavailableFor("authentication", context);
  }
  const changeRequest: ChangeRequest = {
    identity,
    title,
    state,
    ci: { state: ci },
    sourceBranch: chosen.sourceBranch,
    targetBranch: chosen.targetBranch,
    updatedAt: chosen.updatedAt,
    fetchedAt: (input.now?.() ?? new Date()).toISOString(),
    connection: input.connection,
  };
  return { outcome: "available", changeRequest };
}

export interface MergeRequestDetail {
  identity: GitLabIdentity;
  title: string;
  description: string;
  state: ChangeRequestState;
  author: string | null;
  sourceBranch: string;
  targetBranch: string;
  sourceProjectId: number;
  targetProjectId: number;
  headSha: string | null;
  ci: ChangeRequestCiState;
  pipelineUrl: string | null;
  detailedMergeStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  fetchedAt: string;
}

export type MergeRequestDetailResult =
  | { ok: true; value: MergeRequestDetail }
  | { ok: false; reason: GitLabUnavailable["reason"] | "notFound"; message: string };

function safeHttpsUrl(raw: unknown, base: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    const expected = new URL(base);
    return url.protocol === "https:" && url.host === expected.host ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function readMergeRequest(
  transport: GitLabTransport,
  instance: GitLabInstance,
  identity: GitLabIdentity,
  machine: string,
  now: () => Date = () => new Date(),
): Promise<MergeRequestDetailResult> {
  const project = gitlabProjectApiPath(identity.projectId ?? identity.projectPath);
  const response = await transport.get(`${project}/merge_requests/${identity.number}`);
  if (!response.ok) {
    if (response.failure === "notFound") {
      return { ok: false, reason: "notFound", message: `${instance.hostname} has no merge request ${identity.projectPath}!${identity.number} visible to the glab login on ${machine}.` };
    }
    const unavailable = unavailableFor(response.failure, { instance, machine });
    return { ok: false, reason: unavailable.reason, message: unavailable.message };
  }
  const body = (typeof response.body === "object" && response.body !== null ? response.body : {}) as Record<string, unknown>;
  const candidate = mergeRequestCandidate(body);
  const state = mergeRequestState(body);
  if (candidate === null || state === null || candidate.iid !== identity.number) {
    return { ok: false, reason: "network", message: `${instance.hostname} returned a merge request this plugin couldn't read.` };
  }
  const resolved = gitlabIdentity(instance, candidate);
  if (resolved === null) return { ok: false, reason: "unknown", message: provenanceMismatch(instance, candidate.iid).message };
  const pipeline = body.head_pipeline as Record<string, unknown> | null | undefined;
  return {
    ok: true,
    value: {
      identity: resolved,
      title: candidate.title,
      description: typeof body.description === "string" ? body.description : "",
      state,
      author: typeof (body.author as { username?: unknown } | undefined)?.username === "string" ? (body.author as { username: string }).username : null,
      sourceBranch: candidate.sourceBranch,
      targetBranch: candidate.targetBranch,
      sourceProjectId: candidate.sourceProjectId,
      targetProjectId: candidate.targetProjectId,
      headSha: candidate.sha,
      ci: "head_pipeline" in body ? pipelineCiState(pipeline ?? null, candidate.sha) : "unknown",
      pipelineUrl: pipeline ? safeHttpsUrl(pipeline.web_url, instance.base) : null,
      detailedMergeStatus: typeof body.detailed_merge_status === "string" ? body.detailed_merge_status : null,
      createdAt: typeof body.created_at === "string" ? body.created_at : null,
      updatedAt: candidate.updatedAt,
      fetchedAt: now().toISOString(),
    },
  };
}
