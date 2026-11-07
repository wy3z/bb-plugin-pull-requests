import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { glabGet, inspectCheckout, runProcess, type Runner } from "../host";

let root: string;
let repo: string;
let worktree: string;
let fakeBin: string;
let neutral: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    stdio: "pipe",
  }).toString();

const isolatedGit: Runner = (command, args, options) =>
  runProcess(command, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bb-pr-host-"));
  repo = join(root, "repo");
  worktree = join(root, "linked");
  neutral = join(root, "neutral");
  fakeBin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(neutral);
  mkdirSync(fakeBin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", "https://oauth2:glpat-SECRET@gitlab.com/group/sub/project.git");
  git(repo, "remote", "add", "fork", "git@gitlab.com:me/project.git");
  git(repo, "config", "branch.main.remote", "origin");
  git(repo, "config", "branch.main.merge", "refs/heads/main");
  git(repo, "worktree", "add", "-q", "-b", "feature/x", worktree);
  git(repo, "config", "branch.feature/x.remote", "origin");
  git(repo, "config", "branch.feature/x.merge", "refs/heads/feature/renamed");
  git(repo, "config", "branch.feature/x.pushRemote", "fork");
  writeFileSync(
    join(fakeBin, "glab"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$PWD" "$@" > "$FAKE_GLAB_LOG"',
      'case "$FAKE_GLAB_MODE" in',
      '  ok) printf "HTTP/2.0 200 OK\\r\\nX-Next-Page: 3\\r\\n\\r\\n[{\\"iid\\":4}]" ;;',
      '  auth) printf "HTTP/2.0 401 Unauthorized\\r\\n\\r\\n{\\"message\\":\\"401 Unauthorized\\"}"; exit 1 ;;',
      '  offline) printf "Get \\"https://gitlab.com/api/v4/x\\": dial tcp: lookup gitlab.com: no such host\\n" >&2; exit 1 ;;',
      "esac",
    ].join("\n") + "\n",
  );
  chmodSync(join(fakeBin, "glab"), 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inspecting a checkout on the host", () => {
  it("reads branch, upstream and remotes without credentials", async () => {
    const result = await inspectCheckout(isolatedGit, repo);
    expect(result).toMatchObject({ ok: true, branch: "main", upstream: { remote: "origin", branch: "main" }, pushRemote: null });
    expect(result.ok && result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.ok && result.remotes).toEqual([
      { name: "fork", url: "git@gitlab.com:me/project.git" },
      { name: "origin", url: "https://gitlab.com/group/sub/project.git" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("works in a linked worktree, with its own branch, upstream and push remote", async () => {
    const result = await inspectCheckout(isolatedGit, worktree);
    expect(result).toMatchObject({
      ok: true,
      path: worktree,
      branch: "feature/x",
      upstream: { remote: "origin", branch: "feature/renamed" },
      pushRemote: "fork",
    });
  });

  it("separates a missing path, a plain folder and a missing git", async () => {
    expect(await inspectCheckout(isolatedGit, join(root, "nope"))).toEqual({ ok: false, path: join(root, "nope"), error: "missing" });
    expect(await inspectCheckout(isolatedGit, neutral)).toEqual({ ok: false, path: neutral, error: "notGit" });
    const noGit: Runner = (command, args, options) => runProcess(command, args, { ...options, env: { ...options.env, PATH: fakeBin } });
    expect(await inspectCheckout(noGit, repo)).toEqual({ ok: false, path: repo, error: "gitMissing" });
  });
});

describe("glab on the host", () => {
  const withFake = (mode: string, path = fakeBin): { run: Runner; log: string } => {
    const log = join(root, `glab-${mode}.log`);
    return {
      log,
      run: (command, args, options) =>
        runProcess(command, args, { ...options, env: { ...options.env, PATH: path, FAKE_GLAB_MODE: mode, FAKE_GLAB_LOG: log } }),
    };
  };

  it("runs one GET with an explicit hostname from a neutral directory", async () => {
    const { run, log } = withFake("ok");
    expect(await glabGet(run, "gitlab.com", "projects/77/merge_requests/4", neutral)).toEqual({ ok: true, status: 200, nextPage: 3, body: [{ iid: 4 }] });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([neutral, "api", "--hostname", "gitlab.com", "--include", "projects/77/merge_requests/4"]);
  });

  it("reports an expired login as authentication", async () => {
    expect(await glabGet(withFake("auth").run, "gitlab.com", "projects/77/merge_requests/4", neutral)).toEqual({ ok: false, failure: "authentication", status: 401 });
  });

  it("reports an unreachable instance as offline", async () => {
    expect(await glabGet(withFake("offline").run, "gitlab.com", "projects/77/merge_requests/4", neutral)).toEqual({ ok: false, failure: "offline", status: null });
  });

  it("reports a machine without glab as cliMissing", async () => {
    expect(await glabGet(withFake("ok", neutral).run, "gitlab.com", "projects/77/merge_requests/4", neutral)).toEqual({ ok: false, failure: "cliMissing", status: null });
  });
});
