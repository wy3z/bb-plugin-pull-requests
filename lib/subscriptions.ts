// Pull request subscriptions: a thread follows a pull request and gets a
// short "[Subscription update]" message when it changes. Moved here from the
// Subscriptions plugin (GitHub only): the first successful check is a silent
// baseline, changes within the debounce window go out as one message, and a
// message still waiting in the thread's queue is rewritten rather than
// stacked.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const snapshotSchema = z.object({
  title: z.string().max(1000),
  url: z.string().url(),
  state: z.string().max(200),
  updatedAt: z.string(),
  fields: z.record(z.string(), z.string().max(2000)),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** One subscription as the frontend and CLI see it. */
export interface SubscriptionView {
  url: string;
  snapshot: Snapshot | null;
  error: string | null;
  checkedAt: number | null;
}

/** Realtime channel: a thread's subscriptions changed. Payload `{ threadId }`. */
export const SUBSCRIPTIONS_CHANGED = "subscriptions-changed";

const MAX_PER_THREAD = 100;
const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
const backoff = (failures: number) => Math.min(3600_000, 30_000 * 2 ** Math.min(failures, 7));

/** A lookup failure: `retryMs` schedules the row; `pause` pauses every check. */
class CheckError extends Error {
  constructor(
    message: string,
    readonly retryMs = 60_000,
    readonly pause = false,
  ) {
    super(message);
  }
}

const PR_QUERY = `query SubscriptionPR($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    title state isDraft updatedAt headRefOid reviewDecision
    assignees(first: 50) { nodes { login } }
    labels(first: 100) { nodes { name } }
    comments(last: 1) { totalCount nodes { updatedAt author { login } } }
    reviews(last: 1) { totalCount nodes { state submittedAt author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  } }
}`;

const prSchema = z.object({
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  headRefOid: z.string(),
  reviewDecision: z.string().nullable(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({
    totalCount: z.number(),
    nodes: z.array(z.object({ updatedAt: z.string(), author: z.object({ login: z.string() }).nullable() })),
  }),
  reviews: z.object({
    totalCount: z.number(),
    nodes: z.array(
      z.object({ state: z.string(), submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() }),
    ),
  }),
  commits: z.object({
    nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
  }),
});
const envelope = z.object({
  data: z.object({ repository: z.object({ pullRequest: prSchema.nullable() }).nullable() }).optional(),
});

/** "owner/repo#12" for a canonical pull request URL. */
export function shortId(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url;
}

function toSnapshot(url: string, pr: z.infer<typeof prSchema>): Snapshot {
  const review = pr.reviews.nodes[0];
  const comment = pr.comments.nodes[0];
  return {
    title: pr.title,
    url,
    updatedAt: pr.updatedAt,
    state: pr.state === "OPEN" && pr.isDraft ? "draft" : pr.state.toLowerCase(),
    fields: {
      commit: pr.headRefOid.slice(0, 12),
      comments: `${pr.comments.totalCount}${comment ? ` (latest by ${comment.author?.login ?? "unknown"} at ${comment.updatedAt})` : ""}`,
      reviews: `${pr.reviews.totalCount}${review ? ` (${review.author?.login ?? "unknown"}: ${review.state.toLowerCase()} at ${review.submittedAt ?? "pending"})` : ""}`,
      "review decision": pr.reviewDecision?.toLowerCase() ?? "",
      checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() ?? "",
      assignees: pr.assignees.nodes.map((x) => x.login).sort().join(", "),
      labels: pr.labels.nodes.map((x) => x.name).sort().join(", "),
    },
  };
}

const clean = (s: string) =>
  s
    .replace(/[\r\n\t]/g, " ")
    .replace(/[[\]<>`()]/g, "")
    .slice(0, 180);

/** One pull request's changes between two snapshots, or null when nothing tracked changed. */
export function describeChange(url: string, before: Snapshot, after: Snapshot): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(`${clean(before.state)} → ${clean(after.state)}`);
  if (before.title !== after.title) changes.push("title updated");
  for (const key of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (before.fields[key] !== after.fields[key]) {
      changes.push(`${clean(key)}: ${clean(before.fields[key] || "none")} → ${clean(after.fields[key] || "none")}`);
    }
  }
  if (!changes.length) return null;
  return `[${clean(shortId(url))}](${url}): ${changes.slice(0, 5).join("; ")}${changes.length > 5 ? "; other fields updated" : ""}.`;
}

function compose(lines: string[]): string | null {
  if (!lines.length) return null;
  if (lines.length === 1) return `[Subscription update] ${lines[0]}`;
  return `[Subscription update]\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

type Row = {
  thread: string;
  url: string;
  snapshot: string | null;
  error: string | null;
  checked: number | null;
  due: number;
  failures: number;
  generation: string;
};
type Pending = {
  thread: string;
  baselines: string;
  flush_at: number;
  dirty: number;
  queued_id: string | null;
  queued_updated: number | null;
};

export interface SubscriptionsDeps {
  /** Runs a GraphQL query through `gh`; throws an error whose message names the failure kind. */
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
  /** Canonical https://github.com/<owner>/<repo>/pull/<n>, or null. */
  canonicalUrl(raw: string): string | null;
}

export function createSubscriptions(bb: BbPluginApi, deps: SubscriptionsDeps) {
  const settings = bb.settings.define({
    intervalSeconds: {
      type: "number",
      label: "Subscription check interval in seconds",
      default: 60,
      experimental_schema: z.number().int().min(30).max(3600),
    },
    debounceSeconds: {
      type: "number",
      label: "Debounce subscription messages within (seconds)",
      description:
        "Changes seen within this window go out as one message. While a thread is busy, later changes rewrite the message already waiting for it.",
      default: 10,
      experimental_schema: z.number().int().min(0).max(600),
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE subscriptions (thread TEXT NOT NULL, url TEXT NOT NULL, snapshot TEXT, error TEXT, checked INTEGER, due INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL, PRIMARY KEY(thread, url))`,
    `CREATE TABLE pending (thread TEXT PRIMARY KEY, baselines TEXT NOT NULL, flush_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, queued_id TEXT, queued_updated INTEGER)`,
  ]);
  const changed = (threadId: string) => bb.realtime.publish(SUBSCRIPTIONS_CHANGED, { threadId });
  const rows = (threadId: string) =>
    db.prepare("SELECT * FROM subscriptions WHERE thread = ? ORDER BY url").all(threadId) as Row[];

  async function list(threadId: string): Promise<{ subscriptions: SubscriptionView[]; intervalSeconds: number }> {
    return {
      subscriptions: rows(threadId).map((row) => ({
        url: row.url,
        snapshot: row.snapshot ? snapshotSchema.parse(JSON.parse(row.snapshot)) : null,
        error: row.error,
        checkedAt: row.checked,
      })),
      intervalSeconds: (await settings.get()).intervalSeconds,
    };
  }

  // Serializes delivery against unsubscribe: once removal returns, no new send can start.
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn);
    lock = next.catch(() => {});
    return next;
  }

  /** Accepts URLs, owner/repo#12, or a bare number in a project with a GitHub remote. */
  async function canonicalize(threadId: string, raw: string[]): Promise<string[]> {
    let repository: string | null | undefined;
    const out: string[] = [];
    for (const value of raw) {
      const text = value.trim();
      let url = deps.canonicalUrl(text);
      const short = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(text);
      if (!url && short) url = deps.canonicalUrl(`https://github.com/${short[1]}/${short[2]}/pull/${short[3]}`);
      if (!url && /^#?[1-9]\d*$/.test(text)) {
        if (repository === undefined) {
          const thread = await bb.sdk.threads.get({ threadId });
          const project = thread.projectId ? await bb.sdk.projects.get({ projectId: thread.projectId }) : null;
          const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(project?.gitRemoteUrl ?? "");
          repository = match ? `${match[1]}/${match[2]}` : null;
        }
        if (repository) url = deps.canonicalUrl(`https://github.com/${repository}/pull/${text.replace("#", "")}`);
      }
      if (!url) {
        throw new Error(
          `Not a pull request: ${text.slice(0, 200)}. Use a GitHub PR URL or owner/repo#123; a bare number works in a project with a GitHub remote.`,
        );
      }
      out.push(url);
    }
    return [...new Set(out)];
  }

  async function mutate(threadId: string, raw: string[], add: boolean): Promise<{ urls: string[] }> {
    const urls = await canonicalize(threadId, raw);
    return serial(async () => {
      db.transaction(() => {
        if (add) {
          const fresh = urls.filter(
            (url) => !db.prepare("SELECT 1 FROM subscriptions WHERE thread=? AND url=?").get(threadId, url),
          ).length;
          if (rows(threadId).length + fresh > MAX_PER_THREAD) {
            throw new Error(`Maximum ${MAX_PER_THREAD} subscriptions per thread.`);
          }
        }
        for (const url of urls) {
          if (add) {
            db.prepare("INSERT OR IGNORE INTO subscriptions (thread,url,generation) VALUES (?,?,?)").run(
              threadId,
              url,
              randomUUID(),
            );
          } else {
            db.prepare("DELETE FROM subscriptions WHERE thread=? AND url=?").run(threadId, url);
          }
        }
      })();
      changed(threadId);
      return { urls };
    });
  }

  bb.events.on("thread.deleted", ({ thread }) =>
    serial(async () => {
      db.prepare("DELETE FROM subscriptions WHERE thread=?").run(thread.id);
      db.prepare("DELETE FROM pending WHERE thread=?").run(thread.id);
      changed(thread.id);
    }),
  );
  // Once the agent has read (or the user removed) our queued message, later changes start from a fresh baseline.
  const consumed = ({ entry }: { entry: { id: string; threadId: string } }) =>
    serial(async () => {
      db.prepare("DELETE FROM pending WHERE thread=? AND queued_id=?").run(entry.threadId, entry.id);
    });
  bb.events.on("message.dispatched", consumed);
  bb.events.on("message.cancelled", consumed);

  let pausedUntil = 0;
  let pauseMessage = "";
  settings.onChange(() => {
    pausedUntil = 0;
    db.prepare("UPDATE subscriptions SET due=0, failures=0").run();
  });
  const lifecycle = new AbortController();
  bb.onDispose(async () => {
    lifecycle.abort();
    await lock;
  });

  async function fetchSnapshot(url: string): Promise<Snapshot> {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
    if (!match) throw new CheckError("Not a pull request URL.");
    let raw: unknown;
    try {
      raw = await deps.graphql(PR_QUERY, { owner: match[1], repo: match[2], number: Number(match[3]) });
    } catch (cause) {
      const kind = cause instanceof Error ? cause.message : "";
      if (kind === "rateLimited") throw new CheckError("GitHub rate limit reached; pausing checks.", RATE_LIMIT_PAUSE_MS, true);
      if (kind === "authentication") throw new CheckError("gh is not signed in on the bb server.");
      if (kind === "cliUnavailable") throw new CheckError("gh is not installed on the bb server.");
      if (kind === "notFound") throw new CheckError("Pull request not found, or the gh account can't see it.");
      throw new CheckError("GitHub lookup failed; will retry.");
    }
    const parsed = envelope.safeParse(raw);
    const pr = parsed.success ? parsed.data.data?.repository?.pullRequest : null;
    if (!pr) throw new CheckError("Pull request not found, or the gh account can't see it.");
    return toSnapshot(url, pr);
  }

  async function poll(signal: AbortSignal) {
    const config = await settings.get();
    const interval = config.intervalSeconds * 1000;
    const debounce = config.debounceSeconds * 1000;
    const now = Date.now();
    const due = db.prepare("SELECT * FROM subscriptions WHERE due <= ? ORDER BY due LIMIT 100").all(now) as Row[];
    if (!due.length) return;
    // Look each thread up once per sweep; archived threads wait for the next interval.
    const threads = new Map<string, Promise<{ archived: boolean }>>();
    const threadState = (threadId: string) => {
      if (!threads.has(threadId)) {
        threads.set(
          threadId,
          bb.sdk.threads.get({ threadId }).then(
            (t) => ({ archived: t.archivedAt !== null }),
            () => ({ archived: false }),
          ),
        );
      }
      return threads.get(threadId)!;
    };
    const active: Row[] = [];
    for (const row of due) {
      if (signal.aborted) return;
      if ((await threadState(row.thread)).archived) {
        db.prepare("UPDATE subscriptions SET due=? WHERE thread=? AND url=?").run(now + interval, row.thread, row.url);
      } else active.push(row);
    }
    // One read per pull request per sweep, however many threads follow it; four at a time.
    const urls = [...new Set(active.map((row) => row.url))];
    const outcomes = new Map<string, Snapshot | CheckError>();
    if (pausedUntil > now) {
      for (const url of urls) outcomes.set(url, new CheckError(pauseMessage, pausedUntil - now));
    } else {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, urls.length) }, async () => {
          while (next < urls.length && !signal.aborted) {
            const url = urls[next++]!;
            try {
              outcomes.set(url, await fetchSnapshot(url));
            } catch (cause) {
              const error = cause instanceof CheckError ? cause : new CheckError("GitHub lookup failed; will retry.");
              outcomes.set(url, error);
              if (error.pause) {
                pausedUntil = Date.now() + error.retryMs;
                pauseMessage = error.message;
              }
            }
          }
        }),
      );
    }
    if (signal.aborted) return;
    for (const row of active) {
      await deliver(row, outcomes.get(row.url) ?? new CheckError("No result for this pull request; will retry."), interval, debounce, signal);
    }
  }

  /** Note a change for the thread's next message, keeping the oldest unseen baseline per pull request. */
  function record(thread: string, url: string, before: Snapshot, debounce: number) {
    const pending = db.prepare("SELECT * FROM pending WHERE thread=?").get(thread) as Pending | undefined;
    const baselines: Record<string, Snapshot> = pending ? JSON.parse(pending.baselines) : {};
    baselines[url] ??= before;
    if (!pending) {
      db.prepare("INSERT INTO pending (thread,baselines,flush_at,dirty) VALUES (?,?,?,1)").run(
        thread,
        JSON.stringify(baselines),
        Date.now() + debounce,
      );
    } else {
      db.prepare(
        "UPDATE pending SET baselines=?, dirty=1, flush_at=CASE WHEN dirty=1 THEN flush_at WHEN queued_id IS NOT NULL THEN ? ELSE ? END WHERE thread=?",
      ).run(JSON.stringify(baselines), Date.now(), Date.now() + debounce, thread);
    }
  }

  /** Send or rewrite one message per thread whose debounce window has passed. */
  async function flush(signal: AbortSignal) {
    const ready = db.prepare("SELECT * FROM pending WHERE dirty=1 AND flush_at <= ?").all(Date.now()) as Pending[];
    for (const pending of ready) {
      if (signal.aborted) return;
      await serial(async () => {
        const current = db.prepare("SELECT * FROM pending WHERE thread=?").get(pending.thread) as Pending | undefined;
        if (!current || !current.dirty || signal.aborted) return;
        const baselines: Record<string, Snapshot> = JSON.parse(current.baselines);
        const lines: string[] = [];
        for (const [url, before] of Object.entries(baselines)) {
          const row = db.prepare("SELECT snapshot FROM subscriptions WHERE thread=? AND url=?").get(current.thread, url) as
            | Pick<Row, "snapshot">
            | undefined;
          const line = row?.snapshot ? describeChange(url, before, snapshotSchema.parse(JSON.parse(row.snapshot))) : null;
          if (line) lines.push(line);
        }
        const text = compose(lines);
        if (!text) {
          db.prepare("DELETE FROM pending WHERE thread=?").run(current.thread);
          return;
        }
        const input = [{ type: "text" as const, text, mentions: [] }];
        try {
          if (current.queued_id !== null && current.queued_updated !== null) {
            try {
              const updated = await bb.sdk.threads.queuedMessages.update({
                threadId: current.thread,
                queuedMessageId: current.queued_id,
                expectedUpdatedAt: current.queued_updated,
                input,
              });
              db.prepare("UPDATE pending SET dirty=0, queued_updated=? WHERE thread=?").run(updated.updatedAt, current.thread);
              return;
            } catch {
              /* Consumed, edited or removed since: fall through to a fresh send. */
            }
          }
          const sent = await bb.sdk.threads.send({ threadId: current.thread, mode: "queue-if-active", input });
          if (sent.delivery === "queued") {
            db.prepare("UPDATE pending SET dirty=0, queued_id=?, queued_updated=? WHERE thread=?").run(
              sent.queuedMessage.id,
              sent.queuedMessage.updatedAt,
              current.thread,
            );
          } else db.prepare("DELETE FROM pending WHERE thread=?").run(current.thread);
        } catch {
          // Delivery failed (bb offline, thread gone): keep the baselines and retry on a later sweep.
          db.prepare("UPDATE pending SET flush_at=? WHERE thread=?").run(Date.now() + 5_000, current.thread);
        }
      });
    }
  }

  function deliver(row: Row, outcome: Snapshot | CheckError, interval: number, debounce: number, signal: AbortSignal) {
    return serial(async () => {
      const current = db.prepare("SELECT * FROM subscriptions WHERE thread=? AND url=?").get(row.thread, row.url) as
        | Row
        | undefined;
      if (!current || current.generation !== row.generation || signal.aborted) return;
      try {
        if (outcome instanceof CheckError) throw outcome;
        const snapshot = snapshotSchema.parse(outcome);
        const before = current.snapshot ? snapshotSchema.parse(JSON.parse(current.snapshot)) : null;
        if (before && describeChange(row.url, before, snapshot)) record(row.thread, row.url, before, debounce);
        db.prepare("UPDATE subscriptions SET snapshot=?,error=NULL,checked=?,due=?,failures=0 WHERE thread=? AND url=?").run(
          JSON.stringify(snapshot),
          Date.now(),
          Date.now() + interval,
          row.thread,
          row.url,
        );
      } catch (cause) {
        const delay = cause instanceof CheckError ? cause.retryMs : 60_000;
        const message = cause instanceof CheckError ? cause.message : "Check or message delivery failed; will retry.";
        db.prepare("UPDATE subscriptions SET error=?,checked=?,due=?,failures=failures+1 WHERE thread=? AND url=?").run(
          message,
          Date.now(),
          Date.now() + Math.max(delay, backoff(current.failures)),
          row.thread,
          row.url,
        );
      }
      changed(row.thread);
    });
  }

  bb.background.service("watch", {
    async start(serviceSignal) {
      const signal = AbortSignal.any([serviceSignal, lifecycle.signal]);
      while (!signal.aborted) {
        await poll(signal);
        if (!signal.aborted) await flush(signal);
        try {
          await sleep(5000, undefined, { signal });
        } catch {
          if (!signal.aborted) throw new Error("Watcher sleep failed");
        }
      }
    },
  });

  return { list, mutate };
}
