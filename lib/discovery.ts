import type {
  ChangeRequestCiState,
  ChangeRequestProvider,
  ChangeRequestRow,
  ChangeRequestState,
} from "@wy3z/bb-suite/change-requests";
import { chooseForge, glabConnection, type GitLabInstance } from "./change-request";
import type { GitLabHttp, InspectResult } from "./host-contract";
import { discoverMergeRequest } from "./providers/gitlab";

export interface DiscoveryEnvironment {
  id: string;
  hostId: string;
  path: string | null;
  status: string;
  isGitRepo: boolean;
}

export interface DiscoveryHost {
  name: string;
  connected: boolean;
}

export interface DiscoveryDeps {
  environment(environmentId: string): Promise<DiscoveryEnvironment | null>;
  host(hostId: string): Promise<DiscoveryHost | null>;
  inspect(hostId: string, paths: string[]): Promise<InspectResult[]>;
  gitlab(hostId: string, hostname: string, path: string): Promise<GitLabHttp>;
  github(environmentIds: string[]): Promise<Record<string, unknown>>;
  instances(): readonly GitLabInstance[];
  now(): number;
}

const FRESH_MS = 60_000;
const UNAVAILABLE_FRESH_MS = 20_000;
const RATE_LIMIT_MS = 5 * 60_000;
const CACHE_LIMIT = 500;
const GITLAB_CONCURRENCY = 4;

function unavailable(
  provider: ChangeRequestProvider | null,
  reason: Extract<ChangeRequestRow, { outcome: "unavailable" }>["reason"],
  message: string,
): ChangeRequestRow {
  return { outcome: "unavailable", provider, reason, message };
}

const GITHUB_STATES: Record<string, ChangeRequestState> = { open: "open", draft: "draft", merged: "merged", closed: "closed" };

export function githubRowFromStatus(raw: unknown, fetchedAt: string): ChangeRequestRow {
  const row = raw as { outcome?: unknown; pullRequest?: Record<string, unknown>; message?: unknown } | null | undefined;
  if (row?.outcome === "absent") return { outcome: "absent", provider: "github" };
  if (row?.outcome === "unavailable") {
    return unavailable("github", "unknown", typeof row.message === "string" && row.message ? row.message : "GitHub PR Status couldn't read this branch.");
  }
  const pr = row?.outcome === "available" ? row.pullRequest : undefined;
  const match = typeof pr?.url === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9]\d*)\/?$/.exec(pr.url) : null;
  const state = typeof pr?.state === "string" ? GITHUB_STATES[pr.state] : undefined;
  if (!pr || !match || !state || Number(match[2]) !== pr.number) {
    return unavailable("github", "unknown", "GitHub PR Status returned a row this plugin couldn't read.");
  }
  const checks = pr.checks as { totalCount?: unknown; passedCount?: unknown; failedCount?: unknown; pendingCount?: unknown } | undefined;
  let ci: ChangeRequestCiState = "unknown";
  if (checks && typeof checks.totalCount === "number") {
    if (Number(checks.failedCount) > 0) ci = "failed";
    else if (Number(checks.pendingCount) > 0) ci = "pending";
    else if (checks.totalCount === 0) ci = "none";
    else if (checks.passedCount === checks.totalCount) ci = "passed";
  }
  const number = Number(match[2]);
  return {
    outcome: "available",
    changeRequest: {
      identity: { provider: "github", instance: "https://github.com", projectPath: match[1]!, number, url: `https://github.com/${match[1]}/pull/${number}` },
      title: typeof pr.title === "string" ? pr.title : "",
      state,
      ci: { state: ci },
      sourceBranch: typeof pr.headRefName === "string" ? pr.headRefName : null,
      targetBranch: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
      updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
      fetchedAt,
      connection: null,
    },
  };
}

interface CacheEntry {
  at: number;
  row: ChangeRequestRow;
  provenance: string | null;
}

interface Resolved {
  row: ChangeRequestRow;
  provenance: string | null;
}

type Plan =
  | { kind: "row"; row: ChangeRequestRow }
  | { kind: "github" }
  | {
      kind: "gitlab";
      hostId: string;
      path: string;
      head: string | null;
      machine: string;
      instance: GitLabInstance;
      projectPath: string;
      branch: string;
    };

function provenanceOf(step: Extract<Plan, { kind: "gitlab" }>): string {
  return JSON.stringify([step.hostId, step.path, step.instance.base, step.projectPath, step.branch, step.head]);
}

export function createDiscovery(deps: DiscoveryDeps) {
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ChangeRequestRow>>();
  const owners = new Map<string, number>();
  let tickets = 0;
  let epoch = 0;
  const lastProvider = new Map<string, ChangeRequestProvider>();
  const rateLimitedUntil = new Map<string, number>();
  let gitlabActive = 0;
  const gitlabQueue: (() => void)[] = [];

  async function gitlabSlot<T>(run: () => Promise<T>): Promise<T> {
    if (gitlabActive >= GITLAB_CONCURRENCY) await new Promise<void>((resolve) => gitlabQueue.push(resolve));
    gitlabActive += 1;
    try {
      return await run();
    } finally {
      gitlabActive -= 1;
      gitlabQueue.shift()?.();
    }
  }

  function remember(environmentId: string, { row, provenance }: Resolved) {
    const provider = row.outcome === "available" ? row.changeRequest.identity.provider : row.provider;
    if (provider) lastProvider.set(environmentId, provider);
    cache.delete(environmentId);
    cache.set(environmentId, { at: deps.now(), row, provenance });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }

  function fresh(environmentId: string): ChangeRequestRow | null {
    const entry = cache.get(environmentId);
    if (!entry) return null;
    const ttl = entry.row.outcome === "unavailable" ? UNAVAILABLE_FRESH_MS : FRESH_MS;
    return deps.now() - entry.at < ttl ? entry.row : null;
  }

  async function plan(environmentIds: string[]): Promise<Map<string, Plan>> {
    const plans = new Map<string, Plan>();
    const environments = await Promise.all(
      environmentIds.map(async (id) => {
        try {
          return [id, await deps.environment(id)] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    );
    const byHost = new Map<string, { id: string; path: string }[]>();
    for (const [id, environment] of environments) {
      const known = lastProvider.get(id) ?? null;
      if (environment === undefined) {
        plans.set(id, { kind: "row", row: unavailable(known, "unknown", "BB couldn't read this environment.") });
      } else if (environment === null || !environment.isGitRepo) {
        plans.set(id, { kind: "row", row: { outcome: "absent", provider: null } });
      } else if (environment.status !== "ready" || environment.path === null) {
        plans.set(id, { kind: "row", row: unavailable(known, "notReady", "This environment isn't ready yet.") });
      } else {
        const list = byHost.get(environment.hostId) ?? [];
        list.push({ id, path: environment.path });
        byHost.set(environment.hostId, list);
      }
    }
    await Promise.all(
      [...byHost].map(async ([hostId, entries]) => {
        let host: DiscoveryHost | null = null;
        try {
          host = await deps.host(hostId);
        } catch {
          host = null;
        }
        const machine = host?.name || "This machine";
        if (host === null || !host.connected) {
          for (const { id } of entries) {
            plans.set(id, {
              kind: "row",
              row: unavailable(lastProvider.get(id) ?? null, "hostOffline", `${machine} is offline, so its branch's request can't be checked.`),
            });
          }
          return;
        }
        let results: InspectResult[];
        try {
          results = await deps.inspect(hostId, entries.map((entry) => entry.path));
        } catch {
          for (const { id } of entries) {
            plans.set(id, { kind: "row", row: unavailable(lastProvider.get(id) ?? null, "hostOffline", `BB couldn't reach ${machine} to read the checkout.`) });
          }
          return;
        }
        entries.forEach(({ id, path }, index) => {
          const result = results[index];
          const known = lastProvider.get(id) ?? null;
          if (!result || result.path !== path) {
            plans.set(id, { kind: "row", row: unavailable(known, "unknown", `${machine} answered for a different checkout.`) });
            return;
          }
          if (!result.ok) {
            if (result.error === "notGit") plans.set(id, { kind: "row", row: { outcome: "absent", provider: null } });
            else if (result.error === "missing") plans.set(id, { kind: "row", row: unavailable(known, "notReady", `The checkout is missing on ${machine}.`) });
            else if (result.error === "gitMissing") plans.set(id, { kind: "row", row: unavailable(known, "unknown", `git isn't installed on ${machine}.`) });
            else plans.set(id, { kind: "row", row: unavailable(known, "unknown", `${machine} couldn't read the checkout's remotes.`) });
            return;
          }
          const choice = chooseForge(result, deps.instances());
          if (choice.kind === "detached" || choice.kind === "noRemote") {
            plans.set(id, { kind: "row", row: { outcome: "absent", provider: null } });
          } else if (choice.kind === "unsupportedInstance") {
            plans.set(id, {
              kind: "row",
              row: unavailable(
                "gitlab",
                "unsupportedHost",
                choice.reason === "prefix"
                  ? `GitLab installed under a path (${choice.base}) isn't supported yet.`
                  : `More than one GitLab instance in Pull Requests settings claims this remote's host.`,
              ),
            });
          } else if (choice.kind === "unsupported") {
            plans.set(id, {
              kind: "row",
              row: unavailable(
                null,
                "unsupportedHost",
                choice.hosts.length > 0
                  ? `${choice.hosts.join(", ")} isn't GitHub or a known GitLab instance. Add a self-hosted GitLab in Pull Requests settings.`
                  : "This checkout's remotes aren't GitHub or a known GitLab instance.",
              ),
            });
          } else if (choice.candidate.forge.provider === "github") {
            plans.set(id, { kind: "github" });
          } else {
            plans.set(id, {
              kind: "gitlab",
              hostId,
              path,
              head: result.head,
              machine,
              instance: choice.candidate.forge.instance,
              projectPath: choice.candidate.forge.projectPath,
              branch: choice.candidate.branch,
            });
          }
        });
      }),
    );
    return plans;
  }

  async function resolveGitLab(environmentId: string, step: Extract<Plan, { kind: "gitlab" }>): Promise<Resolved> {
    const provenance = provenanceOf(step);
    const backoffKey = `${step.hostId}\n${step.instance.base}`;
    const until = rateLimitedUntil.get(backoffKey) ?? 0;
    if (deps.now() < until) {
      const previous = cache.get(environmentId);
      if (previous && previous.provenance === provenance) return { row: previous.row, provenance };
      return { row: unavailable("gitlab", "rateLimited", `${step.instance.hostname} is rate limiting requests. Try again in a few minutes.`), provenance };
    }
    const row = await gitlabSlot(() =>
      discoverMergeRequest(
        { get: (path) => deps.gitlab(step.hostId, step.instance.hostname, path) },
        {
          instance: step.instance,
          projectPath: step.projectPath,
          branch: step.branch,
          connection: glabConnection(step.hostId),
          machine: step.machine,
          now: () => new Date(deps.now()),
        },
      ),
    );
    if (row.outcome === "unavailable" && row.reason === "rateLimited") rateLimitedUntil.set(backoffKey, deps.now() + RATE_LIMIT_MS);
    return { row, provenance };
  }

  async function load(environmentIds: string[]): Promise<Map<string, Resolved>> {
    const rows = new Map<string, Resolved>();
    const plain = (id: string, row: ChangeRequestRow) => void rows.set(id, { row, provenance: null });
    const plans = await plan(environmentIds);
    const github: string[] = [];
    const gitlab: Promise<void>[] = [];
    for (const id of environmentIds) {
      const step = plans.get(id);
      if (!step) plain(id, unavailable(null, "unknown", "This environment couldn't be checked."));
      else if (step.kind === "row") plain(id, step.row);
      else if (step.kind === "github") github.push(id);
      else
        gitlab.push(
          resolveGitLab(id, step).then(
            (resolved) => void rows.set(id, resolved),
            () => plain(id, unavailable("gitlab", "unknown", "The merge request lookup failed unexpectedly.")),
          ),
        );
    }
    if (github.length > 0) {
      const fetchedAt = new Date(deps.now()).toISOString();
      try {
        const status = await deps.github(github);
        for (const id of github) plain(id, githubRowFromStatus(status[id], fetchedAt));
      } catch {
        for (const id of github) {
          plain(id, unavailable("github", "providerUnavailable", "GitHub PR Status isn't available, so this branch's pull request can't be read here."));
        }
      }
    }
    await Promise.all(gitlab);
    return rows;
  }

  async function read(environmentIds: readonly string[], refresh = false): Promise<Record<string, ChangeRequestRow>> {
    const unique = [...new Set(environmentIds)];
    const result: Record<string, ChangeRequestRow> = {};
    const missing: string[] = [];
    const waiting: Promise<void>[] = [];
    for (const id of unique) {
      const cached = refresh ? null : fresh(id);
      if (cached) result[id] = cached;
      else if (!refresh && inflight.has(id)) waiting.push(inflight.get(id)!.then((row) => void (result[id] = row)));
      else missing.push(id);
    }
    if (missing.length > 0) {
      const startEpoch = epoch;
      const claims = new Map(missing.map((id) => [id, ++tickets] as const));
      for (const [id, ticket] of claims) owners.set(id, ticket);
      const batch = load(missing);
      for (const id of missing) {
        const resolved = batch.then((rows) => rows.get(id)!);
        const one = resolved.then((entry) => entry.row);
        inflight.set(id, one);
        waiting.push(
          resolved.then(
            (entry) => {
              if (inflight.get(id) === one) inflight.delete(id);
              if (epoch === startEpoch && owners.get(id) === claims.get(id)) remember(id, entry);
              result[id] = entry.row;
            },
            () => {
              if (inflight.get(id) === one) inflight.delete(id);
              result[id] = unavailable(lastProvider.get(id) ?? null, "unknown", "This environment couldn't be checked.");
            },
          ),
        );
      }
    }
    await Promise.all(waiting);
    return result;
  }

  function forget(environmentId: string) {
    cache.delete(environmentId);
    inflight.delete(environmentId);
    owners.set(environmentId, ++tickets);
  }

  function clear() {
    epoch += 1;
    cache.clear();
    inflight.clear();
    rateLimitedUntil.clear();
  }

  return { read, forget, clear, cached: (environmentId: string) => cache.get(environmentId)?.row ?? null };
}

export type Discovery = ReturnType<typeof createDiscovery>;
