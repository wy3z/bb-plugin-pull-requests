import type {
  ChangeRequestCiState,
  ChangeRequestIdentity,
  ChangeRequestState,
  GitLabIdentity,
} from "@wy3z/bb-suite/change-requests";

export type RemoteScheme = "https" | "http" | "ssh" | "git" | "scp";

export interface ParsedRemote {
  scheme: RemoteScheme;
  host: string;
  port: number | null;
  path: string;
}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function validProjectPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length >= 2 &&
    segments.length <= 20 &&
    path.length <= 400 &&
    segments.every((segment) => SEGMENT_RE.test(segment) && !segment.endsWith(".git") && segment !== "-")
  );
}

function cleanPath(raw: string): string | null {
  let path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  path = path.replace(/\/+$/, "");
  return validProjectPath(path) ? path : null;
}

export function parseRemoteUrl(raw: string | null | undefined): ParsedRemote | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > 2048 || /\s/.test(value)) return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (schemeMatch) {
    const protocol = schemeMatch[1]!.toLowerCase();
    const scheme: RemoteScheme | null =
      protocol === "https" ? "https" : protocol === "http" ? "http" : protocol === "ssh" || protocol === "git+ssh" || protocol === "ssh+git" ? "ssh" : protocol === "git" ? "git" : null;
    if (scheme === null) return null;
    let url: URL;
    try {
      url = new URL(scheme === "ssh" ? value.replace(/^[^:]+:/, "ssh:") : value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (!HOST_RE.test(host)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    const path = cleanPath(decoded);
    if (path === null) return null;
    return { scheme, host, port: url.port ? Number(url.port) : null, path };
  }
  const scp = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.+)$/.exec(value);
  if (!scp) return null;
  const host = scp[2]!.toLowerCase();
  if (!HOST_RE.test(host) || /^[a-z]$/i.test(host)) return null;
  const path = cleanPath(scp[3]!);
  if (path === null) return null;
  return { scheme: "scp", host, port: null, path };
}

export interface GitLabInstance {
  base: string;
  hostname: string;
  prefix: string;
  sshAliases: string[];
}

export interface InstanceParseResult {
  instances: GitLabInstance[];
  invalid: string[];
}

export const GITLAB_COM: GitLabInstance = {
  base: "https://gitlab.com",
  hostname: "gitlab.com",
  prefix: "",
  sshAliases: ["gitlab.com", "altssh.gitlab.com"],
};

function normaliseBase(raw: string): { base: string; hostname: string; host: string; port: string; prefix: string } | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return null;
  const prefix = url.pathname.replace(/\/+$/, "");
  if (prefix !== "" && !prefix.split("/").slice(1).every((segment) => SEGMENT_RE.test(segment))) return null;
  const hostname = url.port ? `${host}:${url.port}` : host;
  return { base: `https://${hostname}${prefix}`, hostname, host, port: url.port, prefix };
}

export function parseGitLabInstances(text: string | null | undefined): InstanceParseResult {
  const instances: GitLabInstance[] = [];
  const invalid: string[] = [];
  const claims = new Map<string, { base: string; entries: string[] }>();
  for (const name of GITLAB_COM.sshAliases) claims.set(name, { base: GITLAB_COM.base, entries: [] });
  const conflicted = new Set<string>();
  for (const entry of (text ?? "").split(/[\s,]+/).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const alias = eq >= 0 ? entry.slice(0, eq).toLowerCase() : null;
    const target = normaliseBase(eq >= 0 ? entry.slice(eq + 1) : entry);
    if (target === null || (alias !== null && !HOST_RE.test(alias)) || target.host === "github.com" || alias === "github.com") {
      invalid.push(entry);
      continue;
    }
    if (target.base === GITLAB_COM.base && alias === null) continue;
    const sshAliases = alias !== null ? [alias] : target.port === "" && target.prefix === "" ? [target.host] : [];
    for (const name of sshAliases) {
      const claim = claims.get(name);
      if (claim && claim.base !== target.base) {
        conflicted.add(name);
        claim.entries.push(entry);
      } else if (claim) {
        claim.entries.push(entry);
      } else {
        claims.set(name, { base: target.base, entries: [entry] });
      }
    }
    const existing = instances.find((instance) => instance.base === target.base);
    if (existing) {
      for (const name of sshAliases) if (!existing.sshAliases.includes(name)) existing.sshAliases.push(name);
    } else {
      instances.push({ base: target.base, hostname: target.hostname, prefix: target.prefix, sshAliases });
    }
  }
  for (const name of conflicted) {
    for (const entry of claims.get(name)!.entries) if (!invalid.includes(entry)) invalid.push(entry);
    for (const instance of instances) instance.sshAliases = instance.sshAliases.filter((alias) => alias !== name);
  }
  return { instances: instances.filter((instance) => instance.base !== GITLAB_COM.base), invalid };
}

export function knownGitLabInstances(configured: readonly GitLabInstance[]): GitLabInstance[] {
  return [GITLAB_COM, ...configured.filter((instance) => instance.base !== GITLAB_COM.base)];
}

export type ForgeResolution =
  | { provider: "github"; base: "https://github.com"; projectPath: string }
  | { provider: "gitlab"; instance: GitLabInstance; projectPath: string }
  | { provider: "unsupported"; base: string; reason: "prefix" | "conflict" };

export function resolveForge(remote: ParsedRemote, configured: readonly GitLabInstance[]): ForgeResolution | null {
  if (remote.host === "github.com" || remote.host === "ssh.github.com") {
    const parts = remote.path.split("/");
    if (parts.length !== 2) return null;
    return { provider: "github", base: "https://github.com", projectPath: remote.path };
  }
  const known = knownGitLabInstances(configured);
  const web = remote.scheme === "https" || remote.scheme === "http";
  const matches = web
    ? known.filter((instance) => instance.hostname === (remote.port !== null ? `${remote.host}:${remote.port}` : remote.host))
    : known.filter((instance) => instance.sshAliases.includes(remote.host));
  if (matches.length === 0) return null;
  if (web) {
    const prefixed = matches.find((instance) => instance.prefix !== "" && `/${remote.path}`.startsWith(`${instance.prefix}/`));
    if (prefixed) return { provider: "unsupported", base: prefixed.base, reason: "prefix" };
    const root = matches.find((instance) => instance.prefix === "");
    return root ? { provider: "gitlab", instance: root, projectPath: remote.path } : null;
  }
  if (matches.length > 1) return { provider: "unsupported", base: matches[0]!.base, reason: "conflict" };
  const instance = matches[0]!;
  if (instance.prefix !== "") return { provider: "unsupported", base: instance.base, reason: "prefix" };
  return { provider: "gitlab", instance, projectPath: remote.path };
}

export function gitlabProjectApiPath(project: string | number): string {
  return `projects/${typeof project === "number" ? project : encodeURIComponent(project)}`;
}

export function gitlabMergeRequestUrl(base: string, projectPath: string, iid: number): string {
  return `${base}/${projectPath}/-/merge_requests/${iid}`;
}

const GITHUB_PR_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)\/?$/;

export function parseChangeRequestUrl(
  raw: string,
  configured: readonly GitLabInstance[],
): ChangeRequestIdentity | null {
  const value = raw.trim();
  const github = GITHUB_PR_RE.exec(value);
  if (github) {
    const projectPath = `${github[1]}/${github[2]}`;
    const number = Number(github[3]);
    return { provider: "github", instance: "https://github.com", projectPath, number, url: `https://github.com/${projectPath}/pull/${number}` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const authority = url.host.toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, "");
  for (const instance of knownGitLabInstances(configured)) {
    if (instance.prefix !== "" || instance.hostname !== authority) continue;
    const rest = pathname.slice(1);
    const match = /^(.+)\/-\/merge_requests\/([1-9]\d{0,9})$/.exec(rest);
    if (!match || !validProjectPath(match[1]!)) continue;
    const number = Number(match[2]);
    return {
      provider: "gitlab",
      instance: instance.base,
      projectPath: match[1]!,
      number,
      url: gitlabMergeRequestUrl(instance.base, match[1]!, number),
      projectId: null,
    };
  }
  return null;
}

export function mergeRequestState(raw: { state?: unknown; draft?: unknown; work_in_progress?: unknown }): ChangeRequestState | null {
  switch (raw.state) {
    case "opened":
    case "locked":
      return raw.draft === true || raw.work_in_progress === true ? "draft" : "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

export function pipelineCiState(pipeline: unknown, headSha: string | null): ChangeRequestCiState {
  if (pipeline === null) return "none";
  if (typeof pipeline !== "object" || pipeline === undefined) return "unknown";
  const { status, sha } = pipeline as { status?: unknown; sha?: unknown };
  if (typeof sha === "string" && headSha !== null && sha !== headSha) return "unknown";
  switch (status) {
    case "success":
      return "passed";
    case "failed":
      return "failed";
    case "canceled":
    case "canceling":
      return "canceled";
    case "skipped":
      return "skipped";
    case "manual":
    case "blocked":
      return "manual";
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "waiting_for_callback":
    case "pending":
    case "running":
    case "scheduled":
      return "pending";
    default:
      return "unknown";
  }
}

export interface MergeRequestCandidate {
  iid: number;
  projectId: number;
  sourceProjectId: number;
  targetProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  state: ChangeRequestState;
  title: string;
  webUrl: string;
  sha: string | null;
  updatedAt: string | null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function mergeRequestCandidate(raw: unknown): MergeRequestCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const mr = raw as Record<string, unknown>;
  const iid = positiveInt(mr.iid);
  const projectId = positiveInt(mr.project_id);
  const sourceProjectId = positiveInt(mr.source_project_id);
  const targetProjectId = positiveInt(mr.target_project_id) ?? projectId;
  const state = mergeRequestState(mr);
  if (
    iid === null ||
    projectId === null ||
    sourceProjectId === null ||
    targetProjectId === null ||
    state === null ||
    typeof mr.source_branch !== "string" ||
    typeof mr.target_branch !== "string"
  )
    return null;
  return {
    iid,
    projectId,
    sourceProjectId,
    targetProjectId,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    state,
    title: typeof mr.title === "string" ? mr.title.split(/\s+/).filter(Boolean).join(" ") : "",
    webUrl: typeof mr.web_url === "string" ? mr.web_url : "",
    sha: typeof mr.sha === "string" && /^[0-9a-f]{7,64}$/.test(mr.sha) ? mr.sha : null,
    updatedAt: typeof mr.updated_at === "string" ? mr.updated_at : null,
  };
}

export type MergeRequestPick =
  | { kind: "none" }
  | { kind: "one"; mergeRequest: MergeRequestCandidate }
  | { kind: "ambiguous"; count: number };

function active(candidate: MergeRequestCandidate): boolean {
  return candidate.state === "open" || candidate.state === "draft";
}

function ownBranch(candidate: MergeRequestCandidate, branch: string): boolean {
  return (
    candidate.sourceBranch === branch &&
    candidate.sourceProjectId === candidate.targetProjectId &&
    candidate.projectId === candidate.targetProjectId
  );
}

export function pickSameProjectMergeRequest(candidates: readonly MergeRequestCandidate[], branch: string): MergeRequestPick {
  const live = candidates.filter((candidate) => ownBranch(candidate, branch) && active(candidate));
  if (live.length > 1) return { kind: "ambiguous", count: live.length };
  if (live.length === 1) return { kind: "one", mergeRequest: live[0]! };
  return { kind: "none" };
}

export function hasUnverifiedHistory(candidates: readonly MergeRequestCandidate[], branch: string): boolean {
  return candidates.some((candidate) => ownBranch(candidate, branch) && !active(candidate));
}

export function gitlabIdentity(instance: GitLabInstance, candidate: Pick<MergeRequestCandidate, "iid" | "webUrl" | "projectId">): GitLabIdentity | null {
  const suffix = `/-/merge_requests/${candidate.iid}`;
  if (!candidate.webUrl.startsWith(`${instance.base}/`)) return null;
  const rest = candidate.webUrl.slice(instance.base.length + 1).replace(/\/+$/, "");
  if (!rest.endsWith(suffix)) return null;
  const projectPath = rest.slice(0, -suffix.length);
  if (!validProjectPath(projectPath)) return null;
  return {
    provider: "gitlab",
    instance: instance.base,
    projectPath,
    number: candidate.iid,
    url: gitlabMergeRequestUrl(instance.base, projectPath, candidate.iid),
    projectId: candidate.projectId,
  };
}

export interface RemoteFacts {
  name: string;
  remote: ParsedRemote | null;
}

export interface CheckoutFacts {
  branch: string | null;
  head: string | null;
  upstream: { remote: string; branch: string } | null;
  pushRemote: string | null;
  remotes: RemoteFacts[];
}

export interface ForgeCandidate {
  remote: string;
  branch: string;
  forge: Exclude<ForgeResolution, { provider: "unsupported" }>;
}

export type ForgeChoice =
  | { kind: "found"; candidate: ForgeCandidate }
  | { kind: "detached" }
  | { kind: "noRemote" }
  | { kind: "unsupported"; hosts: string[] }
  | { kind: "unsupportedInstance"; base: string; reason: "prefix" | "conflict" };

export function chooseForge(facts: CheckoutFacts, configured: readonly GitLabInstance[]): ForgeChoice {
  if (facts.branch === null) return { kind: "detached" };
  if (facts.remotes.length === 0) return { kind: "noRemote" };
  const order: string[] = [];
  const push = (name: string | null | undefined) => {
    if (name && !order.includes(name) && facts.remotes.some((remote) => remote.name === name)) order.push(name);
  };
  push(facts.pushRemote);
  push(facts.upstream?.remote);
  push("origin");
  for (const remote of facts.remotes) push(remote.name);
  const hosts: string[] = [];
  for (const name of order) {
    const remote = facts.remotes.find((entry) => entry.name === name)!;
    const parsed = remote.remote;
    if (parsed === null) continue;
    const forge = resolveForge(parsed, configured);
    if (forge === null) {
      if (!hosts.includes(parsed.host)) hosts.push(parsed.host);
      continue;
    }
    if (forge.provider === "unsupported") return { kind: "unsupportedInstance", base: forge.base, reason: forge.reason };
    const branch = facts.upstream && facts.upstream.remote === name ? facts.upstream.branch : facts.branch;
    return { kind: "found", candidate: { remote: name, branch, forge } };
  }
  return { kind: "unsupported", hosts };
}

export const CONNECTION_PREFIX = "glab:";

export function glabConnection(hostId: string): string {
  return `${CONNECTION_PREFIX}${hostId}`;
}

export function parseGlabConnection(raw: string | null | undefined): { hostId: string } | null {
  if (typeof raw !== "string" || !raw.startsWith(CONNECTION_PREFIX)) return null;
  const hostId = raw.slice(CONNECTION_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,100}$/.test(hostId) ? { hostId } : null;
}
