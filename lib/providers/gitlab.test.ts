import { describe, expect, it } from "vitest";
import { GITLAB_COM, parseGitLabInstances } from "../change-request";
import { GITLAB_API_PATH_RE, type GitLabHttp } from "../host-contract";
import { classifyGlabStderr, discoverMergeRequest, parseGlabApiOutput, readMergeRequest, type GitLabTransport } from "./gitlab";

const SHA = "b".repeat(40);

function mr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 12,
    project_id: 77,
    source_project_id: 77,
    target_project_id: 77,
    source_branch: "feature/x",
    target_branch: "main",
    state: "opened",
    draft: false,
    title: "Ship it",
    web_url: "https://gitlab.com/group/sub/project/-/merge_requests/12",
    sha: SHA,
    updated_at: "2026-11-06T09:00:00Z",
    ...overrides,
  };
}

function fakeGitLab(routes: Record<string, GitLabHttp | ((path: string) => GitLabHttp)>) {
  const calls: string[] = [];
  const transport: GitLabTransport = {
    async get(path) {
      calls.push(path);
      expect(path).toMatch(GITLAB_API_PATH_RE);
      for (const [prefix, response] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return typeof response === "function" ? response(path) : response;
      }
      return { ok: false, failure: "notFound", status: 404 };
    },
  };
  return { transport, calls };
}

const ok = (body: unknown, nextPage: number | null = null): GitLabHttp => ({ ok: true, status: 200, nextPage, body });
const base = { instance: GITLAB_COM, projectPath: "group/sub/project", branch: "feature/x", connection: "glab:host1", machine: "Laptop", now: () => new Date("2026-11-07T12:00:00Z") };

describe("glab output", () => {
  it("parses a successful response with pagination headers", () => {
    const stdout = 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Next-Page: 2\r\nX-Page: 1\r\n\r\n[{"iid":1}]';
    expect(parseGlabApiOutput(stdout, "", 0)).toEqual({ ok: true, status: 200, nextPage: 2, body: [{ iid: 1 }] });
  });

  it("treats an empty next page header as the last page", () => {
    expect(parseGlabApiOutput("HTTP/1.1 200 OK\nX-Next-Page: \n\n[]", "", 0)).toMatchObject({ ok: true, nextPage: null, body: [] });
  });

  it.each([
    [401, "authentication"],
    [403, "forbidden"],
    [404, "notFound"],
    [429, "rateLimited"],
    [502, "network"],
  ] as const)("maps HTTP %i to %s", (status, failure) => {
    expect(parseGlabApiOutput(`HTTP/2.0 ${status} X\r\n\r\n{"message":"x"}`, "", 1)).toEqual({ ok: false, failure, status });
  });

  it("classifies failures glab reports only on stderr", () => {
    expect(parseGlabApiOutput("", "glab: 401 Unauthorized", 1)).toMatchObject({ failure: "authentication" });
    expect(classifyGlabStderr("none of the git remotes configured for this repository points to a known GitLab host. Please use `glab auth login`")).toBe("authentication");
    expect(classifyGlabStderr('Get "https://gitlab.com/api/v4/projects": dial tcp: lookup gitlab.com: no such host')).toBe("offline");
    expect(classifyGlabStderr("connect: connection refused")).toBe("offline");
    expect(classifyGlabStderr("something odd")).toBe("network");
  });

  it("accepts plain JSON from a glab that ignores --include", () => {
    expect(parseGlabApiOutput('{"iid":1}', "", 0)).toEqual({ ok: true, status: 200, nextPage: null, body: { iid: 1 } });
  });

  it("only allows merge request reads through the host", () => {
    expect(GITLAB_API_PATH_RE.test("projects/group%2Fproject/merge_requests?source_branch=x&state=all")).toBe(true);
    expect(GITLAB_API_PATH_RE.test("projects/77/merge_requests/12")).toBe(true);
    expect(GITLAB_API_PATH_RE.test("projects/77/merge_requests/12/merge")).toBe(false);
    expect(GITLAB_API_PATH_RE.test("user")).toBe(false);
    expect(GITLAB_API_PATH_RE.test("projects/77/merge_requests/../../user")).toBe(false);
  });
});

describe("discovering a branch's merge request", () => {
  it("returns an open MR with its pipeline failure even when it also has conflicts", async () => {
    const { transport, calls } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": ok([mr()]),
      "projects/77/merge_requests/12": ok({ ...mr(), has_conflicts: true, detailed_merge_status: "conflict", head_pipeline: { status: "failed", sha: SHA } }),
    });
    const row = await discoverMergeRequest(transport, base);
    expect(row).toEqual({
      outcome: "available",
      changeRequest: {
        identity: {
          provider: "gitlab",
          instance: "https://gitlab.com",
          projectPath: "group/sub/project",
          number: 12,
          url: "https://gitlab.com/group/sub/project/-/merge_requests/12",
          projectId: 77,
        },
        title: "Ship it",
        state: "open",
        ci: { state: "failed" },
        sourceBranch: "feature/x",
        targetBranch: "main",
        updatedAt: "2026-11-06T09:00:00Z",
        fetchedAt: "2026-11-07T12:00:00.000Z",
        connection: "glab:host1",
      },
    });
    expect(calls[0]).toContain("source_branch=feature%2Fx");
    expect(calls[0]).toContain("state=opened");
  });

  it("keeps a draft's failed pipeline", async () => {
    const { transport } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": ok([mr({ draft: true })]),
      "projects/77/merge_requests/12": ok({ ...mr({ draft: true }), head_pipeline: { status: "failed", sha: SHA } }),
    });
    expect(await discoverMergeRequest(transport, base)).toMatchObject({ changeRequest: { state: "draft", ci: { state: "failed" } } });
  });

  it("reads every page before deciding", async () => {
    const { transport, calls } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": (path) =>
        /[?&]page=1(&|$)/.test(path) ? ok([mr({ iid: 1 })], 2) : ok([mr({ iid: 2 })], null),
    });
    expect(await discoverMergeRequest(transport, base)).toMatchObject({ outcome: "unavailable", reason: "ambiguous", candidates: 2 });
    expect(calls.filter((call) => call.includes("?"))).toHaveLength(2);
  });

  it("never chooses from a truncated candidate list", async () => {
    const { transport } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": (path) => {
        const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
        if (page === 1) return ok([mr({ iid: 1 })], 2);
        if (page < 6) return ok([], page + 1);
        return ok([mr({ iid: 2 })], null);
      },
      "projects/77/merge_requests/": ok({ ...mr({ iid: 1 }), head_pipeline: null }),
    });
    expect(await discoverMergeRequest(transport, base)).toMatchObject({ outcome: "unavailable" });
  });

  it("withholds a merged or closed MR that only shares the branch name", async () => {
    const { transport } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": (path) => (/state=opened/.test(path) ? ok([]) : ok([mr({ iid: 4, state: "merged" })])),
      "projects/77/merge_requests/4": ok({ ...mr({ iid: 4, state: "merged" }), head_pipeline: null }),
    });
    const row = await discoverMergeRequest(transport, base);
    expect(row.outcome).not.toBe("available");
  });

  it("refuses an MR whose web_url is on another instance instead of inventing a URL", async () => {
    const { transport } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": ok([mr({ web_url: "https://other.example/group/sub/project/-/merge_requests/12" })]),
      "projects/77/merge_requests/12": ok({ ...mr({ web_url: "https://other.example/group/sub/project/-/merge_requests/12" }), head_pipeline: null }),
    });
    expect((await discoverMergeRequest(transport, base)).outcome).toBe("unavailable");
  });

  it("encodes every branch character the host allowlist would refuse", async () => {
    const { transport, calls } = fakeGitLab({ "projects/": ok([]) });
    await discoverMergeRequest(transport, { ...base, branch: "fix(ui)!~it's*" });
    expect(calls[0]).toMatch(GITLAB_API_PATH_RE);
    expect(calls[0]).toContain("source_branch=fix%28ui%29%21%7Eit%27s%2A");
  });

  it("says when two open MRs share the branch", async () => {
    const { transport } = fakeGitLab({ "projects/group%2Fsub%2Fproject/merge_requests?": ok([mr({ iid: 1 }), mr({ iid: 2 })]) });
    expect(await discoverMergeRequest(transport, base)).toMatchObject({ outcome: "unavailable", provider: "gitlab", reason: "ambiguous", candidates: 2 });
  });

  it("is absent when GitLab has no MR for the branch", async () => {
    const { transport } = fakeGitLab({ "projects/group%2Fsub%2Fproject/merge_requests?": ok([]) });
    expect(await discoverMergeRequest(transport, base)).toEqual({ outcome: "absent", provider: "gitlab" });
  });

  it.each([
    ["cliMissing", "cliMissing", /glab isn't installed on Laptop/],
    ["authentication", "authentication", /isn't signed in to gitlab\.com/],
    ["offline", "network", /Laptop couldn't reach gitlab\.com/],
    ["notFound", "forbidden", /wouldn't show this project/],
    ["rateLimited", "rateLimited", /rate limiting/],
  ] as const)("reports %s as %s, never as absent", async (failure, reason, message) => {
    const { transport } = fakeGitLab({ "projects/": { ok: false, failure, status: null } });
    const row = await discoverMergeRequest(transport, base);
    expect(row).toMatchObject({ outcome: "unavailable", provider: "gitlab", reason });
    expect(row.outcome === "unavailable" && row.message).toMatch(message);
  });

  it("uses the self-hosted hostname in setup messages", async () => {
    const instance = parseGitLabInstances("git.example.com").instances[0]!;
    const { transport } = fakeGitLab({ "projects/": { ok: false, failure: "authentication", status: 401 } });
    const row = await discoverMergeRequest(transport, { ...base, instance });
    expect(row.outcome === "unavailable" && row.message).toContain("glab auth login --hostname git.example.com");
  });

  it("keeps the MR but marks CI unknown when the detail read fails for a non-auth reason", async () => {
    const { transport } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests?": ok([mr()]),
      "projects/77/merge_requests/12": { ok: false, failure: "network", status: 500 },
    });
    expect(await discoverMergeRequest(transport, base)).toMatchObject({ outcome: "available", changeRequest: { ci: { state: "unknown" } } });
  });
});

describe("reading one merge request", () => {
  const identity = {
    provider: "gitlab" as const,
    instance: "https://gitlab.com",
    projectPath: "group/sub/project",
    number: 12,
    url: "https://gitlab.com/group/sub/project/-/merge_requests/12",
    projectId: null,
  };

  it("returns read-only facts and keeps the pipeline link on the instance", async () => {
    const { transport, calls } = fakeGitLab({
      "projects/group%2Fsub%2Fproject/merge_requests/12": ok({
        ...mr(),
        description: "Body",
        author: { username: "ana" },
        detailed_merge_status: "not_approved",
        created_at: "2026-11-01T00:00:00Z",
        head_pipeline: { status: "running", sha: SHA, web_url: "https://gitlab.com/group/sub/project/-/pipelines/5" },
      }),
    });
    const result = await readMergeRequest(transport, GITLAB_COM, identity, "Laptop", () => new Date("2026-11-07T00:00:00Z"));
    expect(calls).toEqual(["projects/group%2Fsub%2Fproject/merge_requests/12"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        title: "Ship it",
        description: "Body",
        author: "ana",
        state: "open",
        ci: "pending",
        pipelineUrl: "https://gitlab.com/group/sub/project/-/pipelines/5",
        detailedMergeStatus: "not_approved",
      },
    });
  });

  it("drops a pipeline link that points off the instance", async () => {
    const { transport } = fakeGitLab({
      "projects/": ok({ ...mr(), head_pipeline: { status: "success", sha: SHA, web_url: "https://evil.example/x" } }),
    });
    expect(await readMergeRequest(transport, GITLAB_COM, identity, "Laptop")).toMatchObject({ ok: true, value: { pipelineUrl: null, ci: "passed" } });
  });

  it("explains a missing MR and an auth failure truthfully", async () => {
    expect(await readMergeRequest(fakeGitLab({}).transport, GITLAB_COM, identity, "Laptop")).toMatchObject({ ok: false, reason: "notFound" });
    const auth = await readMergeRequest(fakeGitLab({ "projects/": { ok: false, failure: "authentication", status: 401 } }).transport, GITLAB_COM, identity, "Laptop");
    expect(auth).toMatchObject({ ok: false, reason: "authentication" });
  });
});
