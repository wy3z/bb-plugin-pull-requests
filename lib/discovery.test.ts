import { describe, expect, it } from "vitest";
import { parseGitLabInstances } from "./change-request";
import { createDiscovery, githubRowFromStatus, type DiscoveryDeps, type DiscoveryEnvironment } from "./discovery";
import type { GitLabHttp, InspectResult } from "./host-contract";

const SHA = "c".repeat(40);

function checkout(path: string, url: string, branch: string | null = "feature"): InspectResult {
  return { ok: true, path, branch, head: SHA, upstream: branch ? { remote: "origin", branch } : null, pushRemote: null, remotes: [{ name: "origin", url }] };
}

const githubStatus = {
  outcome: "available",
  pullRequest: {
    number: 9,
    title: "GitHub change",
    state: "open",
    url: "https://github.com/owner/repo/pull/9",
    baseRefName: "main",
    headRefName: "feature",
    updatedAt: "2026-11-06T00:00:00Z",
    autoMerge: false,
    inMergeQueue: null,
    checks: { state: "failing", totalCount: 3, passedCount: 1, failedCount: 1, pendingCount: 1 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: null, mergeable: null },
    attention: "checks_failed",
  },
};

function harness(overrides: Partial<DiscoveryDeps> & { checkouts?: Record<string, InspectResult>; environments?: Record<string, DiscoveryEnvironment | null>; gitlabBody?: (path: string) => GitLabHttp } = {}) {
  let now = Date.parse("2026-11-07T12:00:00Z");
  const calls = { inspect: 0, gitlab: [] as { hostId: string; hostname: string; path: string }[], github: [] as string[][] };
  const environments: Record<string, DiscoveryEnvironment | null> = overrides.environments ?? {
    gl: { id: "gl", hostId: "h1", path: "/w/gl", status: "ready", isGitRepo: true },
    gh: { id: "gh", hostId: "h1", path: "/w/gh", status: "ready", isGitRepo: true },
  };
  const checkouts: Record<string, InspectResult> = overrides.checkouts ?? {
    "/w/gl": checkout("/w/gl", "git@gitlab.com:group/sub/project.git"),
    "/w/gh": checkout("/w/gh", "git@github.com:owner/repo.git"),
  };
  const deps: DiscoveryDeps = {
    environment: async (id) => environments[id] ?? null,
    host: async () => ({ name: "Laptop", connected: true }),
    inspect: async (_hostId, paths) => {
      calls.inspect += 1;
      return paths.map((path) => checkouts[path] ?? { ok: false, path, error: "notGit" });
    },
    gitlab: async (hostId, hostname, path) => {
      calls.gitlab.push({ hostId, hostname, path });
      if (overrides.gitlabBody) return overrides.gitlabBody(path);
      if (path.includes("?")) {
        return {
          ok: true,
          status: 200,
          nextPage: null,
          body: [{ iid: 3, project_id: 5, source_project_id: 5, target_project_id: 5, source_branch: "feature", target_branch: "main", state: "opened", title: "MR", web_url: "https://gitlab.com/group/sub/project/-/merge_requests/3", sha: SHA, updated_at: "2026-11-06T00:00:00Z" }],
        };
      }
      return { ok: true, status: 200, nextPage: null, body: { iid: 3, project_id: 5, source_project_id: 5, target_project_id: 5, source_branch: "feature", target_branch: "main", state: "opened", title: "MR", sha: SHA, head_pipeline: { status: "success", sha: SHA } } };
    },
    github: async (keys) => {
      calls.github.push(keys);
      return Object.fromEntries(keys.map((key) => [key, githubStatus]));
    },
    instances: () => [],
    now: () => now,
    ...overrides,
  };
  return { discovery: createDiscovery(deps), calls, advance: (ms: number) => (now += ms) };
}

describe("discovery outcomes", () => {
  it("finds a GitLab MR through glab on the environment's own machine", async () => {
    const { discovery, calls } = harness();
    const rows = await discovery.read(["gl"]);
    expect(rows.gl).toMatchObject({
      outcome: "available",
      changeRequest: { identity: { provider: "gitlab", number: 3, projectPath: "group/sub/project" }, ci: { state: "passed" }, connection: "glab:h1" },
    });
    expect(calls.gitlab.every((call) => call.hostId === "h1" && call.hostname === "gitlab.com")).toBe(true);
    expect(calls.github).toEqual([]);
  });

  it("leaves GitHub branches to GitHub PR Status and normalises its row unchanged", async () => {
    const { discovery, calls } = harness();
    const rows = await discovery.read(["gh"]);
    expect(calls.gitlab).toEqual([]);
    expect(calls.github).toEqual([["gh"]]);
    expect(rows.gh).toMatchObject({
      outcome: "available",
      changeRequest: {
        identity: { provider: "github", projectPath: "owner/repo", number: 9, url: "https://github.com/owner/repo/pull/9" },
        state: "open",
        ci: { state: "failed" },
        connection: null,
      },
    });
  });

  it("says GitHub is unavailable rather than absent when GitHub PR Status is missing", async () => {
    const { discovery } = harness({
      github: async () => {
        throw new Error("unknown plugin");
      },
    });
    expect((await discovery.read(["gh"])).gh).toMatchObject({ outcome: "unavailable", provider: "github", reason: "providerUnavailable" });
  });

  it("reads one host's checkouts in a single call", async () => {
    const { discovery, calls } = harness();
    await discovery.read(["gl", "gh"]);
    expect(calls.inspect).toBe(1);
  });

  it("reports an offline machine without inspecting it", async () => {
    const { discovery, calls } = harness({ host: async () => ({ name: "Build box", connected: false }) });
    const rows = await discovery.read(["gl"]);
    expect(rows.gl).toMatchObject({ outcome: "unavailable", reason: "hostOffline", message: expect.stringContaining("Build box is offline") });
    expect(calls.inspect).toBe(0);
  });

  it("remembers the provider when the machine goes offline later", async () => {
    let connected = true;
    const { discovery, advance } = harness({ host: async () => ({ name: "Laptop", connected }) });
    await discovery.read(["gl"]);
    connected = false;
    advance(61_000);
    expect((await discovery.read(["gl"])).gl).toMatchObject({ outcome: "unavailable", provider: "gitlab", reason: "hostOffline" });
  });

  it("distinguishes not ready, not git, detached and unknown hosts", async () => {
    const { discovery } = harness({
      environments: {
        creating: { id: "creating", hostId: "h1", path: null, status: "creating", isGitRepo: true },
        plain: { id: "plain", hostId: "h1", path: "/w/plain", status: "ready", isGitRepo: false },
        detached: { id: "detached", hostId: "h1", path: "/w/detached", status: "ready", isGitRepo: true },
        bitbucket: { id: "bitbucket", hostId: "h1", path: "/w/bb", status: "ready", isGitRepo: true },
        gone: null,
      },
      checkouts: {
        "/w/detached": checkout("/w/detached", "git@gitlab.com:g/p.git", null),
        "/w/bb": checkout("/w/bb", "git@bitbucket.org:team/p.git"),
      },
    });
    const rows = await discovery.read(["creating", "plain", "detached", "bitbucket", "gone"]);
    expect(rows.creating).toMatchObject({ outcome: "unavailable", reason: "notReady" });
    expect(rows.plain).toEqual({ outcome: "absent", provider: null });
    expect(rows.detached).toEqual({ outcome: "absent", provider: null });
    expect(rows.bitbucket).toMatchObject({ outcome: "unavailable", provider: null, reason: "unsupportedHost", message: expect.stringContaining("bitbucket.org") });
    expect(rows.gone).toEqual({ outcome: "absent", provider: null });
  });

  it("uses a configured self-hosted instance and its hostname for glab", async () => {
    const instances = parseGitLabInstances("corp=https://code.corp.example").instances;
    const { discovery, calls } = harness({
      instances: () => instances,
      environments: { lab: { id: "lab", hostId: "remote-1", path: "/srv/lab", status: "ready", isGitRepo: true } },
      checkouts: { "/srv/lab": checkout("/srv/lab", "corp:platform/tools/cli.git") },
      gitlabBody: () => ({ ok: true, status: 200, nextPage: null, body: [] }),
    });
    expect((await discovery.read(["lab"])).lab).toEqual({ outcome: "absent", provider: "gitlab" });
    expect(calls.gitlab[0]).toMatchObject({ hostId: "remote-1", hostname: "code.corp.example", path: expect.stringContaining("projects/platform%2Ftools%2Fcli/") });
  });

  it("caches a minute, re-reads on refresh and shares in-flight reads", async () => {
    const { discovery, calls, advance } = harness();
    await Promise.all([discovery.read(["gl"]), discovery.read(["gl"])]);
    expect(calls.inspect).toBe(1);
    await discovery.read(["gl"]);
    expect(calls.inspect).toBe(1);
    await discovery.read(["gl"], true);
    expect(calls.inspect).toBe(2);
    advance(61_000);
    await discovery.read(["gl"]);
    expect(calls.inspect).toBe(3);
  });

  it("pauses an instance after a rate limit", async () => {
    const { discovery, calls, advance } = harness({ gitlabBody: () => ({ ok: false, failure: "rateLimited", status: 429 }) });
    expect((await discovery.read(["gl"])).gl).toMatchObject({ reason: "rateLimited" });
    const before = calls.gitlab.length;
    advance(30_000);
    await discovery.read(["gl"], true);
    expect(calls.gitlab.length).toBe(before);
    advance(5 * 60_000);
    await discovery.read(["gl"], true);
    expect(calls.gitlab.length).toBeGreaterThan(before);
  });

  it("does not crash the batch when a host call throws", async () => {
    const { discovery } = harness({
      inspect: async () => {
        throw new Error("transport");
      },
    });
    expect((await discovery.read(["gl", "gh"])).gh).toMatchObject({ outcome: "unavailable", reason: "hostOffline" });
  });
});

describe("GitHub PR Status rows", () => {
  const at = "2026-11-07T00:00:00.000Z";
  it("passes absent through and flags unknown shapes", () => {
    expect(githubRowFromStatus({ outcome: "absent" }, at)).toEqual({ outcome: "absent", provider: "github" });
    expect(githubRowFromStatus({ outcome: "available", pullRequest: { url: "https://gitlab.com/x" } }, at)).toMatchObject({ outcome: "unavailable", provider: "github" });
    expect(githubRowFromStatus({ outcome: "unavailable", message: "gh is not signed in" }, at)).toMatchObject({ message: "gh is not signed in" });
  });

  it("derives CI from check counts, not from the attention summary", () => {
    const row = (checks: Record<string, number>) =>
      githubRowFromStatus({ outcome: "available", pullRequest: { ...githubStatus.pullRequest, attention: "conflicts", checks } }, at);
    expect(row({ totalCount: 2, passedCount: 1, failedCount: 1, pendingCount: 0 })).toMatchObject({ changeRequest: { ci: { state: "failed" } } });
    expect(row({ totalCount: 2, passedCount: 2, failedCount: 0, pendingCount: 0 })).toMatchObject({ changeRequest: { ci: { state: "passed" } } });
    expect(row({ totalCount: 0, passedCount: 0, failedCount: 0, pendingCount: 0 })).toMatchObject({ changeRequest: { ci: { state: "none" } } });
  });
});
