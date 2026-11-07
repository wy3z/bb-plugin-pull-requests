import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { parseRemoteUrl, type ParsedRemote } from "./lib/change-request";
import { hostContract, type GitLabHttp, type InspectResult } from "./lib/host-contract";
import { parseGlabApiOutput } from "./lib/providers/gitlab";

export interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  error: "missing" | "timeout" | "aborted" | "tooLarge" | "failed" | null;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<ProcessOutput>;

export const runProcess: Runner = (command, args, options) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", error: "aborted" });
      return;
    }
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let error: ProcessOutput["error"] = null;
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error });
    };
    const kill = (reason: NonNullable<ProcessOutput["error"]>) => {
      error ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () => kill("aborted");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) return kill("tooLarge");
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= 64 * 1024) err.push(chunk);
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      error ??= cause.code === "ENOENT" ? "missing" : "failed";
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_PAGER: "cat" };
const REMOTE_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const MAX_REMOTES = 10;

export async function inspectCheckout(run: Runner, path: string, signal?: AbortSignal): Promise<InspectResult> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { ok: false, path, error: "missing" };
  } catch {
    return { ok: false, path, error: "missing" };
  }
  const git = (args: string[]) =>
    run("git", ["-C", path, ...args], {
      cwd: path,
      env: { ...process.env, ...GIT_ENV },
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
      signal,
    });
  const probe = await git(["rev-parse", "--is-inside-work-tree"]);
  if (probe.error === "missing") return { ok: false, path, error: "gitMissing" };
  if (probe.error !== null) return { ok: false, path, error: "failed" };
  if (probe.code !== 0 || probe.stdout.trim() !== "true") return { ok: false, path, error: "notGit" };
  const value = async (args: string[]) => {
    const output = await git(args);
    const text = output.stdout.trim();
    return output.code === 0 && output.error === null && text !== "" ? text : null;
  };
  const [branch, head, names] = await Promise.all([
    value(["symbolic-ref", "-q", "--short", "HEAD"]),
    value(["rev-parse", "-q", "--verify", "HEAD"]),
    value(["remote"]),
  ]);
  let upstream: { remote: string; branch: string } | null = null;
  let pushRemote: string | null = null;
  if (branch !== null) {
    const [remote, merge, branchPush, defaultPush] = await Promise.all([
      value(["config", "--get", `branch.${branch}.remote`]),
      value(["config", "--get", `branch.${branch}.merge`]),
      value(["config", "--get", `branch.${branch}.pushRemote`]),
      value(["config", "--get", "remote.pushDefault"]),
    ]);
    if (remote !== null && remote !== "." && merge !== null && merge.startsWith("refs/heads/")) {
      upstream = { remote, branch: merge.slice("refs/heads/".length) };
    }
    pushRemote = branchPush ?? defaultPush;
  }
  const remoteNames = (names ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => REMOTE_NAME_RE.test(name))
    .slice(0, MAX_REMOTES);
  const remotes: { name: string; remote: ParsedRemote | null }[] = [];
  for (const name of remoteNames) {
    const url = await value(["remote", "get-url", name]);
    if (url !== null) remotes.push({ name, remote: parseRemoteUrl(url) });
  }
  return { ok: true, path, branch, head: head && /^[0-9a-f]{40,64}$/.test(head) ? head : null, upstream, pushRemote, remotes };
}

export async function glabGet(run: Runner, hostname: string, apiPath: string, cwd: string, signal?: AbortSignal): Promise<GitLabHttp> {
  const output = await run("glab", ["api", "--hostname", hostname, "--include", apiPath], {
    cwd,
    env: { ...process.env, NO_PROMPT: "true", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1", CLICOLOR: "0" },
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
    signal,
  });
  if (output.error === "missing") return { ok: false, failure: "cliMissing", status: null };
  if (output.error === "timeout") return { ok: false, failure: "offline", status: null };
  if (output.error !== null) return { ok: false, failure: "network", status: null };
  return parseGlabApiOutput(output.stdout, output.stderr, output.code);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspect: async ({ paths }, context) => {
      const results = new Array<InspectResult>(paths.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, paths.length) }, async () => {
          while (next < paths.length) {
            const index = next++;
            results[index] = await inspectCheckout(runProcess, paths[index]!, context.signal);
          }
        }),
      );
      return { results };
    },
    gitlabGet: ({ hostname, path }, context) =>
      glabGet(runProcess, hostname, path, context.experimental_paths.tempDir || tmpdir(), context.signal),
  },
});
