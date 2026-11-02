// Pull Requests — backend.
//
// A port of Zeron's GitHub pull request engine
// (crates/engine/src/source_control.rs, MIT): every read goes through the
// signed-in `gh` CLI with prompts disabled and GH_HOST pinned to github.com,
// using the same GraphQL queries, CI rollup rules and error classes. Nothing
// is executed through a shell, and request bodies travel on stdin.
import { spawn } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ciFromChecks,
  checkFailed,
  repositoryFromRemote,
  validHeadOid,
  validRepository,
  type Mergeability,
  type PullRequestCheck,
  type PullRequestCi,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestListItem,
  type PullRequestPage,
  type PullRequestReviewThread,
  type ReviewDecision,
} from "./lib/model";

// ---------------------------------------------------------------------------
// Errors

export type PullRequestError =
  | "cliUnavailable"
  | "authentication"
  | "rateLimited"
  | "network"
  | "notFound"
  | "unsupported";

class GhError extends Error {
  constructor(readonly kind: PullRequestError) {
    super(kind);
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: PullRequestError };

function classifyFailure(stderr: string): PullRequestError {
  const text = stderr.toLowerCase();
  if (text.includes("could not resolve to a repository") || text.includes("could not resolve to a pullrequest"))
    return "notFound";
  if (text.includes("rate limit") || text.includes("secondary rate")) return "rateLimited";
  if (
    text.includes("not logged") ||
    text.includes("authentication") ||
    text.includes("authenticate") ||
    text.includes("gh auth login") ||
    text.includes("bad credentials")
  )
    return "authentication";
  return "network";
}

// ---------------------------------------------------------------------------
// gh runner

const GH_TIMEOUT_MS = 30_000;
const GH_OUTPUT_LIMIT = 16 * 1024 * 1024;

interface GhOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

function runGh(args: string[], stdin?: string): Promise<GhOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GhError("network"));
    }, GH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GH_OUTPUT_LIMIT) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new GhError(error.code === "ENOENT" ? "cliUnavailable" : "network"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated) return reject(new GhError("network"));
      resolve({
        success: code === 0,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.end(stdin ?? "");
  });
}

async function ghJson(args: string[], stdin?: string): Promise<any> {
  const output = await runGh(args, stdin);
  if (!output.success) throw new GhError(classifyFailure(output.stderr));
  try {
    return JSON.parse(output.stdout);
  } catch {
    throw new GhError("network");
  }
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  return ghJson(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
}

// ---------------------------------------------------------------------------
// Queries (verbatim from Zeron)

const SEARCH_QUERY =
  "query($search: String!, $owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { nameWithOwner } search(query: $search, type: ISSUE, first: 50, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { author { login } headRefOid viewerDidAuthor viewerLatestReviewRequest { id } reviewRequests(first: 100) { nodes { id } pageInfo { hasNextPage } } statusCheckRollup { commit { oid } state contexts { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } number title url state isDraft mergeable reviewDecision createdAt updatedAt additions deletions repository { nameWithOwner } } } } }";

const PR_METADATA_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid viewerDidAuthor viewerLatestReviewRequest { id } reviewRequests(first: 100) { nodes { id } pageInfo { hasNextPage } } statusCheckRollup { commit { oid } state contexts(first: 100) { nodes { ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }";

const COMMENT_FIELDS = "id url body createdAt author { login } viewerDidAuthor replyTo { id }";
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) { ${PAGE_INFO} nodes { id isResolved isOutdated path line originalLine comments(first:100) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } } } } } } }`;
const THREAD_REPLIES_QUERY = `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } } } } }`;

const DETAIL_FIELDS =
  "title,body,url,number,author,baseRefName,headRefName,headRefOid,state,isDraft,reviewDecision,mergeable,additions,deletions,comments,reviews,files,statusCheckRollup";

// ---------------------------------------------------------------------------
// Decoding

function reviewDecision(raw: unknown): ReviewDecision {
  switch (String(raw ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "REVIEW_REQUIRED":
      return "reviewRequired";
    default:
      return "unknown";
  }
}

function mergeability(raw: unknown): Mergeability {
  switch (String(raw ?? "").toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

/** Zeron's `GhPrMetadata::into_fields`: CI, head and viewer relationship. */
function metadataFields(node: any): {
  head: string;
  ci: PullRequestCi;
  authored: boolean | null;
  requested: boolean | null;
} {
  const head = typeof node.headRefOid === "string" ? node.headRefOid : "";
  let ci: PullRequestCi;
  if (!("statusCheckRollup" in node)) ci = { state: "unknown", totalCount: 0 };
  else if (node.statusCheckRollup === null) ci = { state: "noChecks", totalCount: 0 };
  else {
    const rollup = node.statusCheckRollup;
    const contexts = rollup.contexts ?? {};
    const total = Number(contexts.totalCount ?? 0);
    const runCounts: { state: string; count: number }[] = contexts.checkRunCountsByState ?? [];
    const statusCounts: { state: string; count: number }[] =
      contexts.statusContextCountsByState ?? [];
    let state: PullRequestCi["state"] =
      rollup.state === "SUCCESS"
        ? "passed"
        : rollup.state === "FAILURE" || rollup.state === "ERROR"
          ? "failed"
          : rollup.state === "PENDING" || rollup.state === "EXPECTED"
            ? "pending"
            : "unknown";
    const skipped = runCounts
      .filter((c) => c.state === "NEUTRAL" || c.state === "SKIPPED")
      .reduce((sum, c) => sum + c.count, 0);
    if (state === "passed" && total === 0) state = "noChecks";
    if (state === "passed" && skipped > 0 && skipped === total) state = "skipped";
    // Aggregate success must never hide failed or cancelled jobs, even if
    // GitHub does not consider them required for merging.
    if ([...runCounts, ...statusCounts].some((c) => c.count > 0 && checkFailed(c.state)))
      state = "failed";
    if (rollup.commit && rollup.commit.oid !== head) state = "unknown";
    ci = { state, totalCount: total };
  }
  let requested: boolean | null = null;
  if (node.reviewRequests) {
    const latest = node.viewerLatestReviewRequest?.id;
    const found =
      latest != null &&
      (node.reviewRequests.nodes ?? []).some((r: any) => r && r.id === latest);
    requested = found ? true : node.reviewRequests.pageInfo?.hasNextPage ? null : false;
  }
  const authored = typeof node.viewerDidAuthor === "boolean" ? node.viewerDidAuthor : null;
  return { head, ci, authored, requested };
}

function toListItem(node: any): PullRequestListItem | null {
  const repository = String(node?.repository?.nameWithOwner ?? "").trim();
  const title = String(node?.title ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!node || !node.number || !validRepository(repository) || node.state !== "OPEN" || !title)
    return null;
  let url: string;
  try {
    const parsed = new URL(String(node.url).trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    url = parsed.toString();
  } catch {
    return null;
  }
  const meta = metadataFields(node);
  return {
    repository,
    number: node.number,
    title,
    url,
    author: node.author?.login ?? "",
    headRefOid: meta.head,
    ci: meta.ci,
    viewerDidAuthor: meta.authored,
    viewerReviewRequested: meta.requested,
    isDraft: node.isDraft === true,
    reviewDecision: reviewDecision(node.reviewDecision),
    mergeability: mergeability(node.mergeable),
    additions: Number(node.additions ?? 0),
    deletions: Number(node.deletions ?? 0),
    createdAt: String(node.createdAt),
    updatedAt: String(node.updatedAt),
  };
}

function toCheck(node: any): PullRequestCheck {
  const text = (field: string) => (typeof node?.[field] === "string" ? node[field] : "");
  return {
    name: text("name"),
    context: text("context"),
    status: text("status"),
    conclusion: text("conclusion"),
    state: text("state"),
    detailsUrl: text("detailsUrl"),
    targetUrl: text("targetUrl"),
  };
}

function toComment(node: any, viewer: string | null): PullRequestComment {
  const author = node?.author?.login ?? "";
  return {
    id: String(node?.id ?? ""),
    url: String(node?.url ?? ""),
    author,
    body: String(node?.body ?? ""),
    createdAt: String(node?.createdAt ?? node?.submittedAt ?? ""),
    state: String(node?.state ?? ""),
    viewerDidAuthor:
      node?.viewerDidAuthor === true || (viewer !== null && author !== "" && author === viewer),
    replyTo: node?.replyTo?.id ?? null,
  };
}

/** Accept only canonical https://github.com/<owner>/<repo>/pull/<n> URLs. */
function validatedPullRequestUrl(raw: string): { url: string; owner: string; name: string; number: number } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GhError("unsupported");
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const number = Number(parts[3]);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !validRepository(`${parts[0]}/${parts[1]}`) ||
    !Number.isInteger(number) ||
    number <= 0
  )
    throw new GhError("unsupported");
  return {
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}`,
    owner: parts[0]!,
    name: parts[1]!,
    number,
  };
}

const CURSOR_RE = /^[A-Za-z0-9+/=_:-]{1,256}$/;

// ---------------------------------------------------------------------------
// Fetchers

async function fetchScopedSearch(
  repository: string,
  filter: "authored" | "reviewing" | "all",
  after: string | null,
): Promise<{ page: PullRequestPage; canonical: string | null }> {
  const [owner, name] = repository.split("/");
  const qualifier =
    filter === "authored" ? "author:@me " : filter === "reviewing" ? "review-requested:@me " : "";
  const output = await runGh(
    ["api", "graphql", "--input", "-"],
    JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        owner,
        name,
        search: `is:pr is:open ${qualifier}repo:${repository} sort:updated-desc`,
        after,
      },
    }),
  );
  let response: any = null;
  try {
    response = JSON.parse(output.stdout);
  } catch {
    // fall through
  }
  // `gh` exits non-zero whenever the response carries `errors`, including the
  // one that accompanies results the viewer cannot read. Those pages are
  // still usable once the repository itself resolved.
  if (!response?.data || (!output.success && !response.data.repository)) {
    if (!output.success) throw new GhError(classifyFailure(output.stderr));
    throw new GhError("network");
  }
  const partial = Array.isArray(response.errors) && response.errors.length > 0;
  const canonical: string | null = response.data.repository?.nameWithOwner ?? null;
  const items: PullRequestListItem[] = [];
  for (const node of response.data.search?.nodes ?? []) {
    const item = toListItem(node);
    if (!item) continue;
    if (partial) {
      item.ci = { state: "unknown", totalCount: 0 };
      item.viewerDidAuthor = null;
      item.viewerReviewRequested = null;
    }
    if (filter === "authored") item.viewerDidAuthor = true;
    if (filter === "reviewing") item.viewerReviewRequested = true;
    items.push(item);
  }
  items.sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.repository.localeCompare(b.repository) ||
      a.number - b.number,
  );
  const info = response.data.search?.pageInfo;
  const nextCursor =
    info?.hasNextPage && items.length > 0 && CURSOR_RE.test(info.endCursor ?? "")
      ? (info.endCursor as string)
      : null;
  return {
    page: {
      items: items.slice(0, 50),
      nextCursor,
      totalCount: typeof response.data.search?.issueCount === "number" ? response.data.search.issueCount : null,
      fetchedAt: new Date().toISOString(),
    },
    canonical: canonical && validRepository(canonical) ? canonical : null,
  };
}

async function fetchPage(
  repository: string,
  filter: "authored" | "reviewing" | "all",
  after: string | null,
): Promise<PullRequestPage & { repository: string }> {
  const { page, canonical } = await fetchScopedSearch(repository, filter, after);
  if (
    after === null &&
    page.items.length === 0 &&
    canonical &&
    canonical.toLowerCase() !== repository.toLowerCase()
  ) {
    // Search does not follow repository renames, although repository() does.
    // Follow only that verified canonical name, at most once.
    const followed = await fetchScopedSearch(canonical, filter, null);
    return { ...followed.page, repository: canonical };
  }
  return { ...page, repository: canonical ?? repository };
}

async function fetchReviewThreads(
  owner: string,
  name: string,
  number: number,
  viewer: string | null,
): Promise<PullRequestReviewThread[]> {
  const threads: PullRequestReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const value = await graphql(REVIEW_THREADS_QUERY, { owner, name, number, after: cursor });
    if (value.errors) throw new GhError("network");
    const connection = value.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new GhError("network");
    for (const node of connection.nodes ?? []) {
      if (!node) continue;
      const comments = (node.comments?.nodes ?? []).filter(Boolean).map((c: any) => toComment(c, viewer));
      let info = node.comments?.pageInfo;
      for (let more = 0; info?.hasNextPage && more < 10; more++) {
        const replies = await graphql(THREAD_REPLIES_QUERY, { id: node.id, after: info.endCursor });
        const conn = replies.data?.node?.comments;
        if (!conn) break;
        comments.push(...(conn.nodes ?? []).filter(Boolean).map((c: any) => toComment(c, viewer)));
        info = conn.pageInfo;
      }
      threads.push({
        id: String(node.id),
        isResolved: node.isResolved === true,
        isOutdated: node.isOutdated === true,
        path: String(node.path ?? ""),
        line: typeof node.line === "number" ? node.line : null,
        originalLine: typeof node.originalLine === "number" ? node.originalLine : null,
        comments,
      });
    }
    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

async function fetchDetail(rawUrl: string): Promise<PullRequestDetail> {
  const { url, owner, name, number } = validatedPullRequestUrl(rawUrl);
  const value = await ghJson(["pr", "view", url, "--json", DETAIL_FIELDS]);
  const checksReported = Array.isArray(value.statusCheckRollup);
  let checks: PullRequestCheck[] = (value.statusCheckRollup ?? []).filter(Boolean).map(toCheck);
  let ci: PullRequestCi = checksReported ? ciFromChecks(checks) : { state: "unknown", totalCount: 0 };
  let authored: boolean | null = null;
  let requested: boolean | null = null;
  let viewer: string | null = null;
  const head = String(value.headRefOid ?? "");
  if (validHeadOid(head)) {
    try {
      const meta = await graphql(PR_METADATA_QUERY, { owner, name, number });
      if (!meta.errors?.length) {
        viewer = meta.data?.viewer?.login || null;
        const node = meta.data?.repository?.pullRequest;
        if (node) {
          const fields = metadataFields(node);
          if (fields.head === head) {
            const nodes = node.statusCheckRollup?.contexts?.nodes;
            if (node.statusCheckRollup === null) checks = [];
            else if (Array.isArray(nodes)) checks = nodes.filter(Boolean).map(toCheck);
            else if (fields.ci.state !== ci.state) checks = [];
            ci = fields.ci;
            authored = fields.authored;
            requested = fields.requested;
          } else {
            // Check names belong to an older head: do not attest to them
            // after the branch moved between the two reads.
            ci = { state: "unknown", totalCount: 0 };
            checks = [];
          }
        }
      }
    } catch {
      // Metadata is optional; the assessment reports what is missing.
    }
  }
  let reviewThreads: PullRequestReviewThread[] | null = null;
  try {
    reviewThreads = await fetchReviewThreads(owner, name, number, viewer);
  } catch {
    reviewThreads = null;
  }
  const files: PullRequestFile[] = (value.files ?? []).map((f: any) => ({
    path: String(f.path ?? ""),
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
  }));
  return {
    url,
    repository: `${owner}/${name}`,
    number: Number(value.number ?? number),
    title: String(value.title ?? ""),
    body: String(value.body ?? ""),
    author: value.author?.login ?? "",
    state: String(value.state ?? ""),
    isDraft: value.isDraft === true,
    baseRefName: String(value.baseRefName ?? ""),
    headRefName: String(value.headRefName ?? ""),
    headRefOid: head,
    reviewDecision: reviewDecision(value.reviewDecision),
    mergeability: mergeability(value.mergeable),
    additions: Number(value.additions ?? 0),
    deletions: Number(value.deletions ?? 0),
    ci,
    viewerDidAuthor: authored,
    viewerReviewRequested: requested,
    viewerLogin: viewer,
    checks,
    comments: (value.comments ?? []).map((c: any) => toComment(c, viewer)),
    reviews: (value.reviews ?? [])
      .filter((r: any) => r && (r.body || r.state !== "COMMENTED"))
      .map((r: any) => toComment(r, viewer)),
    reviewThreads,
    files,
    fetchedAt: new Date().toISOString(),
  };
}

export interface DiffFile {
  path: string;
  patch: string;
}

/** Split a multi-file unified diff into one patch per file. */
function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
    const minus = /^--- a\/(.+)$/m.exec(chunk);
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const path = plus?.[1] ?? header?.[2] ?? minus?.[1] ?? "unknown";
    files.push({ path, patch: chunk });
  }
  return files;
}

async function fetchDiff(rawUrl: string): Promise<DiffFile[]> {
  const { url } = validatedPullRequestUrl(rawUrl);
  const output = await runGh(["pr", "diff", url, "--color=never"]);
  if (!output.success) throw new GhError(classifyFailure(output.stderr));
  return splitDiff(output.stdout);
}

/** Explicit user submission only. Never retried after an ambiguous failure. */
async function postComment(rawUrl: string, body: string): Promise<PullRequestComment> {
  const { owner, name, number } = validatedPullRequestUrl(rawUrl);
  const value = await ghJson(
    ["api", "--method", "POST", `repos/${owner}/${name}/issues/${number}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
  return {
    id: String(value.node_id ?? ""),
    url: String(value.html_url ?? ""),
    author: String(value.user?.login ?? ""),
    body: String(value.body ?? body),
    createdAt: String(value.created_at ?? new Date().toISOString()),
    state: "",
    viewerDidAuthor: true,
    replyTo: null,
  };
}

// ---------------------------------------------------------------------------
// Cache: one shared read per key, fresh for a minute; a rate limit pauses
// every GitHub read for 15 minutes, keeping loaded results.

const FRESH_MS = 60_000;
const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
const CACHE_LIMIT = 200;

class RequestCache {
  private entries = new Map<string, { at: number; value: unknown }>();
  private inFlight = new Map<string, Promise<unknown>>();
  private rateLimitedAt: number | null = null;

  async get<T>(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (!refresh && cached && Date.now() - cached.at < FRESH_MS) return cached.value as T;
    if (this.rateLimitedAt !== null && Date.now() - this.rateLimitedAt < RATE_LIMIT_PAUSE_MS) {
      if (cached) return cached.value as T;
      throw new GhError("rateLimited");
    }
    const running = this.inFlight.get(key);
    if (running) return running as Promise<T>;
    const promise = load().then(
      (value) => {
        this.inFlight.delete(key);
        this.entries.delete(key);
        this.entries.set(key, { at: Date.now(), value });
        while (this.entries.size > CACHE_LIMIT) {
          this.entries.delete(this.entries.keys().next().value as string);
        }
        return value;
      },
      (error) => {
        this.inFlight.delete(key);
        if (error instanceof GhError && error.kind === "rateLimited") this.rateLimitedAt = Date.now();
        throw error;
      },
    );
    this.inFlight.set(key, promise);
    return promise;
  }

  evictPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of [...this.inFlight.keys()]) if (key.startsWith(prefix)) this.inFlight.delete(key);
  }
}

async function guard<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof GhError) return { ok: false, error: error.kind };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// RPC

const filterSchema = z.enum(["authored", "reviewing", "all"]);
const urlSchema = z.string().url().max(300);
const result = <T>() => z.custom<Result<T>>();

export interface RepositoryChoice {
  projectId: string;
  projectName: string;
  repository: string;
  /** The project's icon from the Cursor Sidebar plugin, in its stored form. */
  icon: string | null;
}

const projectIconsSchema = z.object({
  icons: z.array(z.object({ projectId: z.string(), icon: z.string() })),
});

export interface Preferences {
  repository: string | null;
  filter: "authored" | "reviewing" | "all";
  stars: string[];
  /** Repositories chosen here, newest first. */
  recent: string[];
}

export const rpcContract = defineRpcContract({
  repositories: {
    input: z.null(),
    output: z.custom<{ choices: RepositoryChoice[] }>(),
  },
  preferences_get: {
    input: z.null(),
    output: z.custom<Preferences>(),
  },
  preferences_set: {
    input: z.object({
      repository: z.string().max(200).nullable().optional(),
      filter: filterSchema.optional(),
    }),
    output: z.custom<Preferences>(),
  },
  star_toggle: {
    input: z.object({ key: z.string().min(1).max(400) }),
    output: z.custom<{ stars: string[] }>(),
  },
  list: {
    input: z.object({
      repository: z.string().max(200),
      filter: filterSchema,
      after: z.string().regex(CURSOR_RE).nullable(),
      refresh: z.boolean(),
    }),
    output: result<PullRequestPage & { repository: string }>(),
  },
  detail: {
    input: z.object({ url: urlSchema, refresh: z.boolean() }),
    output: result<PullRequestDetail>(),
  },
  diff: {
    input: z.object({ url: urlSchema, refresh: z.boolean() }),
    output: result<DiffFile[]>(),
  },
  comment: {
    input: z.object({ url: urlSchema, body: z.string().trim().min(1).max(60_000) }),
    output: result<PullRequestComment>(),
  },
});

const PREFERENCES_KEY = "preferences";
const DEFAULT_PREFERENCES: Preferences = { repository: null, filter: "authored", stars: [], recent: [] };

export default async function plugin(bb: BbPluginApi) {
  const cache = new RequestCache();

  async function readPreferences(): Promise<Preferences> {
    const stored = await bb.storage.kv.get<Partial<Preferences>>(PREFERENCES_KEY);
    return { ...DEFAULT_PREFERENCES, ...(stored ?? {}) };
  }
  async function writePreferences(next: Preferences): Promise<Preferences> {
    await bb.storage.kv.set(PREFERENCES_KEY, next);
    return next;
  }

  /**
   * Project icons live in the Cursor Sidebar plugin's own database. Read them
   * through its RPC; without that plugin every project keeps the folder.
   */
  async function readProjectIcons(): Promise<Map<string, string>> {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "cursor-sidebar",
        method: "listProjectIcons",
        input: {},
        outputSchema: projectIconsSchema,
        signal: AbortSignal.timeout(5_000),
      });
      return new Map(result.icons.map((row) => [row.projectId, row.icon]));
    } catch {
      return new Map();
    }
  }

  bb.rpc.register(rpcContract, {
    repositories: async () => {
      const [projects, icons] = await Promise.all([bb.sdk.projects.list(), readProjectIcons()]);
      const seen = new Set<string>();
      const choices: RepositoryChoice[] = [];
      for (const project of projects) {
        const repository = repositoryFromRemote(project.gitRemoteUrl);
        if (!repository || seen.has(repository.toLowerCase())) continue;
        seen.add(repository.toLowerCase());
        choices.push({
          projectId: project.id,
          projectName: project.name,
          repository,
          icon: icons.get(project.id) ?? null,
        });
      }
      return { choices };
    },
    preferences_get: () => readPreferences(),
    preferences_set: async (input) => {
      const current = await readPreferences();
      const next = { ...current };
      if (input.repository !== undefined) {
        next.repository = input.repository && validRepository(input.repository) ? input.repository : null;
        if (next.repository) {
          const chosen = next.repository;
          next.recent = [chosen, ...current.recent.filter((r) => r.toLowerCase() !== chosen.toLowerCase())].slice(0, 8);
        }
      }
      if (input.filter) next.filter = input.filter;
      return writePreferences(next);
    },
    star_toggle: async ({ key }) => {
      const current = await readPreferences();
      const stars = current.stars.includes(key)
        ? current.stars.filter((s) => s !== key)
        : [...current.stars, key].slice(-500);
      await writePreferences({ ...current, stars });
      return { stars };
    },
    list: ({ repository, filter, after, refresh }) =>
      guard(async () => {
        if (!validRepository(repository)) throw new GhError("unsupported");
        const key = `list:${repository.toLowerCase()}:${filter}:${after ?? ""}`;
        return cache.get(key, refresh, () => fetchPage(repository, filter, after));
      }),
    detail: ({ url, refresh }) =>
      guard(async () => {
        const canonical = validatedPullRequestUrl(url).url;
        return cache.get(`detail:${canonical}`, refresh, () => fetchDetail(canonical));
      }),
    diff: ({ url, refresh }) =>
      guard(async () => {
        const canonical = validatedPullRequestUrl(url).url;
        return cache.get(`diff:${canonical}`, refresh, () => fetchDiff(canonical));
      }),
    comment: ({ url, body }) =>
      guard(async () => {
        const posted = await postComment(url, body);
        // Evict after GitHub accepted the write so the next read shows it.
        cache.evictPrefix(`detail:${validatedPullRequestUrl(url).url}`);
        return posted;
      }),
  });

  bb.log.info("loaded");
}
