import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitActionResult } from "@wy3z/bb-suite/contracts";

class ActionError extends Error {}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_EDITOR: "true" };

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Run> {
  return new Promise((done) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd,
        env: { ...process.env, ...GIT_ENV, ...options.env },
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ code, stdout, stderr: stderr || (error && !stderr ? error.message : "") });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function must(command: string, args: readonly string[], cwd: string, failure: string, options?: Parameters<typeof run>[3]) {
  const result = await run(command, args, cwd, options);
  if (result.code !== 0) throw new ActionError(`${failure}: ${firstLine(result.stderr || result.stdout)}`);
  return result.stdout;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.replace(/^(error|fatal|hint|remote):\s*/i, "").trim())
    .find((part) => part.length > 0);
  return line ?? "unknown error";
}

interface Checkout {
  path: string;
  branch: string | null;
  baseBranch: string | null;
}

async function checkout(bb: BbPluginApi, environmentId: string): Promise<Checkout> {
  const environment = await bb.sdk.environments.get({ environmentId });
  const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
  if (host.machineProviderId !== null) {
    throw new ActionError("This only works for environments on the BB server's own machine");
  }
  const path = environment.path ? resolve(environment.path) : null;
  if (!path || !existsSync(path)) throw new ActionError("The environment's checkout isn't on this machine");
  const top = (await must("git", ["rev-parse", "--show-toplevel"], path, "Not a git checkout")).trim();
  if (resolve(top) !== path) throw new ActionError("The environment's path isn't the root of its checkout");
  const branch = (await must("git", ["rev-parse", "--abbrev-ref", "HEAD"], path, "Couldn't read the branch")).trim();
  return {
    path,
    branch: branch === "HEAD" ? null : branch,
    baseBranch: environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch ?? null,
  };
}

async function guard(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof ActionError ? error.message : error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function hasChanges(path: string): Promise<boolean> {
  return (await must("git", ["status", "--porcelain"], path, "Couldn't read git status")).trim().length > 0;
}

async function push(target: Checkout): Promise<string> {
  if (target.branch === null) throw new ActionError("Detached HEAD: check out a branch before pushing");
  await must("git", ["push", "-u", "origin", `HEAD:refs/heads/${target.branch}`], target.path, "Push failed", {
    timeoutMs: 120_000,
  });
  return target.branch;
}

async function head(path: string): Promise<{ sha: string; subject: string }> {
  const [sha, subject] = (await must("git", ["log", "-1", "--format=%H%n%s"], path, "Couldn't read the commit")).split("\n");
  return { sha: sha ?? "", subject: subject ?? "" };
}

async function untrackedCount(path: string): Promise<number> {
  const out = await must("git", ["ls-files", "--others", "--exclude-standard", "-z"], path, "Couldn't list untracked files");
  return out.split("\0").filter((item) => item !== "").length;
}

export function commit(bb: BbPluginApi, input: { environmentId: string; message: string; push: boolean; includeUntracked: boolean }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    if (!(await hasChanges(target.path))) throw new ActionError("Nothing to commit");
    const message = input.message.trim();
    const untracked = await untrackedCount(target.path);
    let created: { sha: string; subject: string };
    if (message === "") {
      if (untracked > 0 && !input.includeUntracked) {
        throw new ActionError(`Type a commit message: ${untracked} untracked ${untracked === 1 ? "file is" : "files are"} left out, and a generated commit could include them`);
      }
      const result = await bb.sdk.environments.commit({ environmentId: input.environmentId });
      created = { sha: result.commitSha, subject: result.commitSubject };
    } else {
      await must("git", ["add", input.includeUntracked ? "-A" : "-u"], target.path, "Couldn't stage the changes");
      const staged = await run("git", ["diff", "--cached", "--quiet"], target.path);
      if (staged.code === 0) {
        throw new ActionError(untracked > 0 ? "Only untracked files changed. Tick Include untracked to commit them" : "Nothing to commit");
      }
      await must("git", ["commit", "-F", "-"], target.path, "Commit failed", { input: `${message}\n` });
      created = await head(target.path);
    }
    const pushed = input.push ? await push(target) : null;
    return { ok: true, sha: created.sha, subject: created.subject, branch: pushed ?? target.branch ?? undefined };
  });
}

export function pushBranch(bb: BbPluginApi, input: { environmentId: string }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    const branch = await push(target);
    return { ok: true, branch };
  });
}

export function createPullRequest(bb: BbPluginApi, input: { environmentId: string }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    if (target.branch === null) throw new ActionError("Detached HEAD: check out a branch first");
    if (target.baseBranch !== null && target.branch === target.baseBranch) {
      throw new ActionError(`You're on ${target.branch}: a pull request needs its own branch`);
    }
    if (await hasChanges(target.path)) throw new ActionError("Commit your changes first");
    const existing = await run("gh", ["pr", "view", target.branch, "--json", "url,state", "-q", "select(.state==\"OPEN\") | .url"], target.path);
    if (existing.code === 0 && existing.stdout.trim().startsWith("https://")) {
      await push(target);
      return { ok: true, url: existing.stdout.trim(), existed: true, branch: target.branch };
    }
    await push(target);
    const args = ["pr", "create", "--fill", "--head", target.branch];
    if (target.baseBranch !== null) args.push("--base", target.baseBranch);
    const out = await must("gh", args, target.path, "Couldn't create the pull request", { timeoutMs: 120_000 });
    const url = out.split(/\s+/).find((part) => part.startsWith("https://github.com/"));
    if (!url) throw new ActionError("gh didn't return a pull request URL");
    return { ok: true, url, existed: false, branch: target.branch };
  });
}

export function applyLocally(bb: BbPluginApi, input: { sourceEnvironmentId: string; targetEnvironmentId: string }) {
  return guard(async () => {
    if (input.sourceEnvironmentId === input.targetEnvironmentId) throw new ActionError("Already in this checkout");
    const [source, target] = await Promise.all([
      checkout(bb, input.sourceEnvironmentId),
      checkout(bb, input.targetEnvironmentId),
    ]);
    const common = async (path: string) =>
      resolve(path, (await must("git", ["rev-parse", "--git-common-dir"], path, "Couldn't read the repository")).trim());
    if ((await common(source.path)) !== (await common(target.path))) {
      throw new ActionError("The two checkouts aren't the same repository");
    }
    const targetHead = (await must("git", ["rev-parse", "HEAD"], target.path, "Couldn't read the checkout's commit")).trim();
    const base = (await must("git", ["merge-base", "HEAD", targetHead], source.path, "No common history with this checkout")).trim();

    const scratch = await mkdtemp(join(tmpdir(), "bb-agent-pills-"));
    let patch: string;
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await must("git", ["read-tree", "HEAD"], source.path, "Couldn't read the worktree", { env });
      await must("git", ["add", "-A"], source.path, "Couldn't collect the worktree's changes", { env });
      patch = await must("git", ["diff", "--cached", "--binary", base], source.path, "Couldn't build the patch", { env });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (patch.trim() === "") throw new ActionError("Nothing to apply");

    const check = await run("git", ["apply", "--check", "--binary", "-"], target.path, { input: patch });
    if (check.code !== 0) throw new ActionError(`Doesn't apply cleanly (already applied, or it conflicts): ${firstLine(check.stderr)}`);
    const stat = await must("git", ["apply", "--numstat", "-"], target.path, "Couldn't read the patch", { input: patch });
    await must("git", ["apply", "--binary", "-"], target.path, "Apply failed", { input: patch });
    return { ok: true, files: stat.split("\n").filter((line) => line.trim() !== "").length };
  });
}
