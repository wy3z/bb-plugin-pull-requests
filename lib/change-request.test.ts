import { describe, expect, it } from "vitest";
import {
  changeRequestKey,
  changeRequestLabel,
  changeRequestRowSchema,
  openChangeRequestDetail,
  rowProvider,
} from "@wy3z/bb-suite/change-requests";
import {
  chooseForge,
  gitlabIdentity,
  glabConnection,
  hasUnverifiedHistory,
  mergeRequestCandidate,
  mergeRequestState,
  parseChangeRequestUrl,
  parseGitLabInstances,
  parseGlabConnection,
  parseRemoteUrl,
  pickSameProjectMergeRequest,
  pipelineCiState,
  resolveForge,
  type CheckoutFacts,
  type MergeRequestCandidate,
} from "./change-request";

const selfHosted = parseGitLabInstances("git.example.com, corp-gl=https://code.corp.example, prefixed=https://lab.corp.example/gitlab").instances;

describe("remote parsing", () => {
  it.each([
    ["https://gitlab.com/group/sub/project.git", { scheme: "https", host: "gitlab.com", port: null, path: "group/sub/project" }],
    ["https://user:secret@gitlab.com/group/project/", { scheme: "https", host: "gitlab.com", port: null, path: "group/project" }],
    ["ssh://git@gitlab.com:2222/group/sub/deeper/project.git", { scheme: "ssh", host: "gitlab.com", port: 2222, path: "group/sub/deeper/project" }],
    ["git@gitlab.com:group/sub/project.git", { scheme: "scp", host: "gitlab.com", port: null, path: "group/sub/project" }],
    ["gitlab.com:group/project", { scheme: "scp", host: "gitlab.com", port: null, path: "group/project" }],
    ["git@GitHub.com:Owner/Repo.git", { scheme: "scp", host: "github.com", port: null, path: "Owner/Repo" }],
    ["https://git.example.com:8443/Team/Project.git", { scheme: "https", host: "git.example.com", port: 8443, path: "Team/Project" }],
  ])("parses %s", (raw, expected) => {
    expect(parseRemoteUrl(raw)).toEqual(expected);
  });

  it.each([
    "",
    "/srv/git/project.git",
    "../project",
    "file:///srv/git/project.git",
    "C:\\repos\\project",
    "https://gitlab.com/project",
    "https://gitlab.com/group/../project",
    "git@gitlab.com:group project",
  ])("rejects %s", (raw) => {
    expect(parseRemoteUrl(raw)).toBeNull();
  });

  it("keeps no userinfo, query or fragment in a parsed remote", () => {
    const parsed = parseRemoteUrl("https://oauth2:glpat-secret@gitlab.com/group/project.git?private_token=x#frag");
    expect(parsed).toEqual({ scheme: "https", host: "gitlab.com", port: null, path: "group/project" });
    expect(parseRemoteUrl("git@gitlab.com:group/project.git?private_token=x")).toBeNull();
  });
});

describe("GitLab instances", () => {
  it("accepts bare hosts and aliases, rejecting anything that isn't https", () => {
    const parsed = parseGitLabInstances("git.example.com\nalias=https://code.corp.example/gitlab, http://plain.example, github.com, a=b=c");
    expect(parsed.instances).toEqual([
      { base: "https://git.example.com", hostname: "git.example.com", prefix: "", sshAliases: ["git.example.com"] },
      { base: "https://code.corp.example/gitlab", hostname: "code.corp.example", prefix: "/gitlab", sshAliases: ["alias"] },
    ]);
    expect(parsed.invalid).toEqual(["http://plain.example", "github.com", "a=b=c"]);
  });

  it("rejects an SSH alias two instances claim", () => {
    const parsed = parseGitLabInstances("shared=https://a.example shared=https://b.example gitlab.com=https://c.example");
    expect(parsed.instances.every((instance) => instance.sshAliases.length === 0)).toBe(true);
    expect(parsed.invalid).toEqual(["shared=https://a.example", "shared=https://b.example", "gitlab.com=https://c.example"]);
  });

  it("resolves gitlab.com without configuration and self-hosted only when listed", () => {
    expect(resolveForge(parseRemoteUrl("git@gitlab.com:group/sub/project.git")!, [])).toMatchObject({
      provider: "gitlab",
      instance: { base: "https://gitlab.com", hostname: "gitlab.com" },
      projectPath: "group/sub/project",
    });
    expect(resolveForge(parseRemoteUrl("git@git.example.com:team/project.git")!, [])).toBeNull();
    expect(resolveForge(parseRemoteUrl("git@git.example.com:team/project.git")!, selfHosted)).toMatchObject({
      provider: "gitlab",
      instance: { base: "https://git.example.com" },
      projectPath: "team/project",
    });
  });

  it("maps an explicit SSH alias, and HTTPS only by exact authority", () => {
    expect(resolveForge(parseRemoteUrl("corp-gl:platform/tools/cli.git")!, selfHosted)).toMatchObject({
      instance: { base: "https://code.corp.example", hostname: "code.corp.example" },
      projectPath: "platform/tools/cli",
    });
    expect(resolveForge(parseRemoteUrl("https://code.corp.example/platform/tools/cli.git")!, selfHosted)).toMatchObject({
      projectPath: "platform/tools/cli",
    });
    expect(resolveForge(parseRemoteUrl("git@code.corp.example:platform/tools/cli.git")!, selfHosted)).toBeNull();
  });

  it("reports an install under a path prefix as unsupported rather than routing it to the root", () => {
    expect(resolveForge(parseRemoteUrl("https://lab.corp.example/gitlab/platform/cli.git")!, selfHosted)).toEqual({
      provider: "unsupported",
      base: "https://lab.corp.example/gitlab",
      reason: "prefix",
    });
    expect(resolveForge(parseRemoteUrl("prefixed:platform/cli.git")!, selfHosted)).toMatchObject({ provider: "unsupported", reason: "prefix" });
    expect(parseChangeRequestUrl("https://lab.corp.example/gitlab/platform/cli/-/merge_requests/3", selfHosted)).toBeNull();
  });

  it("matches an HTTPS remote's authority exactly, port included", () => {
    const both = parseGitLabInstances("git.example.com:8443 git.example.com").instances;
    expect(resolveForge(parseRemoteUrl("https://git.example.com/g/p.git")!, both)).toMatchObject({ instance: { base: "https://git.example.com" } });
    expect(resolveForge(parseRemoteUrl("https://git.example.com:8443/g/p.git")!, both)).toMatchObject({ instance: { base: "https://git.example.com:8443" } });
    expect(resolveForge(parseRemoteUrl("git@git.example.com:g/p.git")!, both)).toMatchObject({ instance: { base: "https://git.example.com" } });
    const portOnly = parseGitLabInstances("git.example.com:8443").instances;
    expect(resolveForge(parseRemoteUrl("https://git.example.com/g/p.git")!, portOnly)).toBeNull();
  });

  it("never treats an unknown host as GitLab because of its name", () => {
    expect(resolveForge(parseRemoteUrl("git@gitlab.internal.example:group/project.git")!, [])).toBeNull();
  });

  it("keeps GitHub remotes on the GitHub path", () => {
    expect(resolveForge(parseRemoteUrl("git@github.com:owner/repo.git")!, selfHosted)).toEqual({
      provider: "github",
      base: "https://github.com",
      projectPath: "owner/repo",
    });
    expect(resolveForge(parseRemoteUrl("https://github.com/owner/group/repo")!, [])).toBeNull();
  });
});

describe("identity", () => {
  it("labels GitLab requests with ! and GitHub with #", () => {
    expect(changeRequestLabel({ provider: "gitlab", number: 12 })).toBe("!12");
    expect(changeRequestLabel({ provider: "github", number: 12 })).toBe("#12");
  });

  it("keys requests by instance and project so equal numbers never collide", () => {
    const a = parseChangeRequestUrl("https://gitlab.com/group/project/-/merge_requests/12", selfHosted)!;
    const b = parseChangeRequestUrl("https://git.example.com/group/project/-/merge_requests/12", selfHosted)!;
    const c = parseChangeRequestUrl("https://github.com/group/project/pull/12", selfHosted)!;
    expect(new Set([a, b, c].map(changeRequestKey)).size).toBe(3);
  });

  it("parses nested GitLab paths and keeps their case", () => {
    expect(parseChangeRequestUrl("https://gitlab.com/Group/Sub/Deeper/Project/-/merge_requests/7/", [])).toEqual({
      provider: "gitlab",
      instance: "https://gitlab.com",
      projectPath: "Group/Sub/Deeper/Project",
      number: 7,
      url: "https://gitlab.com/Group/Sub/Deeper/Project/-/merge_requests/7",
      projectId: null,
    });
    expect(parseChangeRequestUrl("https://code.corp.example/platform/cli/-/merge_requests/3", selfHosted)).toMatchObject({
      instance: "https://code.corp.example",
      projectPath: "platform/cli",
    });
  });

  it("refuses merge request URLs on unknown instances, credentials or plain http", () => {
    expect(parseChangeRequestUrl("https://unknown.example/group/project/-/merge_requests/1", selfHosted)).toBeNull();
    expect(parseChangeRequestUrl("https://user:pw@gitlab.com/group/project/-/merge_requests/1", [])).toBeNull();
    expect(parseChangeRequestUrl("http://gitlab.com/group/project/-/merge_requests/1", [])).toBeNull();
    expect(parseChangeRequestUrl("https://gitlab.com/group/project/-/issues/1", [])).toBeNull();
  });

  it("takes identity only from a web_url on the same instance, never inventing one", () => {
    const instance = parseGitLabInstances("git.example.com").instances[0]!;
    expect(gitlabIdentity(instance, mergeRequestCandidate(mr({ iid: 4, web_url: "https://evil.example/team/project/-/merge_requests/4" }))!)).toBeNull();
    expect(gitlabIdentity(instance, mergeRequestCandidate(mr({ iid: 4, web_url: "https://git.example.com/team/project/-/merge_requests/5" }))!)).toBeNull();
    const trusted = mergeRequestCandidate(mr({ iid: 4, web_url: "https://git.example.com/Team/Project/-/merge_requests/4" }))!;
    expect(gitlabIdentity(instance, trusted)).toMatchObject({ projectPath: "Team/Project", projectId: 10, url: "https://git.example.com/Team/Project/-/merge_requests/4" });
  });

  it("round-trips a glab connection without accepting arbitrary text", () => {
    expect(parseGlabConnection(glabConnection("host_abc-1"))).toEqual({ hostId: "host_abc-1" });
    expect(parseGlabConnection("glab:../../etc")).toBeNull();
    expect(parseGlabConnection("pat:anything")).toBeNull();
  });
});

function mr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 1,
    project_id: 10,
    source_project_id: 10,
    target_project_id: 10,
    source_branch: "feature",
    target_branch: "main",
    state: "opened",
    draft: false,
    title: "Add  feature",
    web_url: "https://gitlab.com/group/project/-/merge_requests/1",
    sha: "a".repeat(40),
    updated_at: "2026-11-01T10:00:00Z",
    ...overrides,
  };
}

function candidates(...rows: Record<string, unknown>[]): MergeRequestCandidate[] {
  return rows.map((row) => mergeRequestCandidate(mr(row))!);
}

describe("state and pipeline", () => {
  it("normalises states, including drafts and the legacy WIP flag", () => {
    expect(mergeRequestState({ state: "opened", draft: true })).toBe("draft");
    expect(mergeRequestState({ state: "opened", work_in_progress: true })).toBe("draft");
    expect(mergeRequestState({ state: "locked" })).toBe("open");
    expect(mergeRequestState({ state: "merged" })).toBe("merged");
    expect(mergeRequestState({ state: "closed" })).toBe("closed");
    expect(mergeRequestState({ state: "weird" })).toBeNull();
  });

  it("reads the pipeline on its own, and distrusts one for another commit", () => {
    expect(pipelineCiState({ status: "failed", sha: "abc1234" }, "abc1234")).toBe("failed");
    expect(pipelineCiState({ status: "success", sha: "def5678" }, "abc1234")).toBe("unknown");
    expect(pipelineCiState(null, "abc1234")).toBe("none");
    expect(pipelineCiState({ status: "manual" }, null)).toBe("manual");
    expect(pipelineCiState({ status: "canceled" }, null)).toBe("canceled");
    expect(pipelineCiState({ status: "preparing" }, null)).toBe("pending");
    expect(pipelineCiState({ status: "new-thing" }, null)).toBe("unknown");
  });
});

describe("picking the branch's merge request", () => {
  it("prefers the single active request over newer history", () => {
    const pick = pickSameProjectMergeRequest(
      candidates({ iid: 1, state: "merged", updated_at: "2026-11-05T00:00:00Z" }, { iid: 2, state: "opened" }),
      "feature",
    );
    expect(pick).toMatchObject({ kind: "one", mergeRequest: { iid: 2 } });
  });

  it("reports two open requests for one branch as ambiguous instead of choosing", () => {
    expect(pickSameProjectMergeRequest(candidates({ iid: 1 }, { iid: 2, draft: true }), "feature")).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("never picks a merged or closed request by branch name alone", () => {
    const history = candidates({ iid: 3, state: "closed" }, { iid: 4, state: "merged" });
    expect(pickSameProjectMergeRequest(history, "feature")).toEqual({ kind: "none" });
    expect(hasUnverifiedHistory(history, "feature")).toBe(true);
    expect(hasUnverifiedHistory(history, "other")).toBe(false);
  });

  it("ignores requests from forks and other branches", () => {
    expect(
      pickSameProjectMergeRequest(candidates({ iid: 5, source_project_id: 99 }, { iid: 6, source_branch: "other" }), "feature"),
    ).toEqual({ kind: "none" });
  });
});

const remoteFacts = (name: string, url: string) => ({ name, remote: parseRemoteUrl(url) });

describe("choosing the remote", () => {
  const facts = (overrides: Partial<CheckoutFacts>): CheckoutFacts => ({
    branch: "feature",
    head: "a".repeat(40),
    upstream: null,
    pushRemote: null,
    remotes: [],
    ...overrides,
  });

  it("uses the push remote, then upstream, then origin, then the rest", () => {
    const remotes = [
      remoteFacts("backup", "git@gitlab.com:mirror/project.git"),
      remoteFacts("origin", "git@gitlab.com:group/project.git"),
      remoteFacts("fork", "git@gitlab.com:me/project.git"),
    ];
    expect(chooseForge(facts({ remotes }), [])).toMatchObject({ kind: "found", candidate: { remote: "origin" } });
    expect(chooseForge(facts({ remotes, pushRemote: "fork" }), [])).toMatchObject({ kind: "found", candidate: { remote: "fork" } });
    expect(
      chooseForge(facts({ remotes, upstream: { remote: "backup", branch: "renamed" } }), []),
    ).toMatchObject({ kind: "found", candidate: { remote: "backup", branch: "renamed" } });
  });

  it("skips remotes it can't place and reports unknown hosts", () => {
    expect(
      chooseForge(facts({ remotes: [remoteFacts("origin", "git@bitbucket.org:team/project.git"), remoteFacts("lab", "git@git.example.com:team/project.git")] }), selfHosted),
    ).toMatchObject({ kind: "found", candidate: { remote: "lab", forge: { provider: "gitlab" } } });
    expect(chooseForge(facts({ remotes: [remoteFacts("origin", "git@bitbucket.org:team/project.git")] }), [])).toEqual({
      kind: "unsupported",
      hosts: ["bitbucket.org"],
    });
  });

  it("has nothing to look up on a detached HEAD or without remotes", () => {
    expect(chooseForge(facts({ branch: null }), [])).toEqual({ kind: "detached" });
    expect(chooseForge(facts({}), [])).toEqual({ kind: "noRemote" });
  });
});

describe("shared row contract", () => {
  it("degrades an unknown row to unavailable instead of failing the whole record", () => {
    expect(changeRequestRowSchema.parse({ outcome: "available", changeRequest: { identity: { provider: "bitbucket" } } })).toMatchObject({
      outcome: "unavailable",
      reason: "unknown",
    });
    expect(changeRequestRowSchema.parse({ outcome: "unavailable", provider: "gitlab", reason: "newReason", message: "m" })).toMatchObject({
      provider: "gitlab",
      reason: "unknown",
    });
  });

  it("knows the provider of every row", () => {
    expect(rowProvider({ outcome: "absent", provider: "gitlab" })).toBe("gitlab");
    expect(rowProvider(undefined)).toBeNull();
  });

  it("reads open event details defensively", () => {
    expect(openChangeRequestDetail({ url: "https://gitlab.com/g/p/-/merge_requests/1", connection: "glab:h1", threadId: "thr_abc" })).toEqual({
      url: "https://gitlab.com/g/p/-/merge_requests/1",
      connection: "glab:h1",
      threadId: "thr_abc",
    });
    expect(openChangeRequestDetail({ url: "https://github.com/o/r/pull/1", threadId: "<script>" })).toEqual({ url: "https://github.com/o/r/pull/1" });
    expect(openChangeRequestDetail("nope")).toBeNull();
  });
});
