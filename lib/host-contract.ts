import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const GITLAB_FAILURES = [
  "cliMissing",
  "authentication",
  "forbidden",
  "notFound",
  "rateLimited",
  "offline",
  "network",
] as const;
export type GitLabFailure = (typeof GITLAB_FAILURES)[number];

export const GITLAB_HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
export const GITLAB_API_PATH_RE =
  /^projects\/[A-Za-z0-9%._-]{1,600}\/merge_requests(?:\/[1-9]\d{0,9})?(?:\?[A-Za-z0-9_.%=&-]{0,400})?$/;

const remoteSchema = z.object({
  name: z.string(),
  remote: z
    .object({
      scheme: z.enum(["https", "http", "ssh", "git", "scp"]),
      host: z.string(),
      port: z.number().int().nullable(),
      path: z.string(),
    })
    .strict()
    .nullable(),
});

export const inspectResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    upstream: z.object({ remote: z.string(), branch: z.string() }).nullable(),
    pushRemote: z.string().nullable(),
    remotes: z.array(remoteSchema),
  }),
  z.object({ ok: z.literal(false), path: z.string(), error: z.enum(["missing", "notGit", "gitMissing", "failed"]) }),
]);
export type InspectResult = z.infer<typeof inspectResultSchema>;

export const gitlabHttpSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: z.number().int(), nextPage: z.number().int().positive().nullable(), body: z.unknown() }),
  z.object({ ok: z.literal(false), failure: z.enum(GITLAB_FAILURES), status: z.number().int().nullable() }),
]);
export type GitLabHttp = z.infer<typeof gitlabHttpSchema>;

export const hostContract = defineRpcContract({
  inspect: {
    experimental_description: "Read a checkout's branch, HEAD, upstream and remote URLs without fetching or changing anything.",
    experimental_retryable: true,
    input: z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }),
    output: z.object({ results: z.array(inspectResultSchema) }),
  },
  gitlabGet: {
    experimental_description: "One read-only GitLab REST GET through this machine's signed-in glab.",
    experimental_retryable: true,
    input: z.object({
      hostname: z.string().regex(GITLAB_HOSTNAME_RE),
      path: z.string().regex(GITLAB_API_PATH_RE),
    }),
    output: gitlabHttpSchema,
  },
});
