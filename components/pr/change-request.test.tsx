import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MergeRequestDetail } from "@/lib/providers/gitlab";
import { MergeRequestBody, type MergeRequestBodyProps } from "./change-request";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
    Markdown: ({ content }: { content: string }) => React.createElement("p", null, content),
  },
};

const now = Date.parse("2026-11-08T12:00:00.000Z");

const detail: MergeRequestDetail = {
  identity: {
    provider: "gitlab",
    instance: "https://gitlab.com",
    projectPath: "group/sub/project",
    number: 12,
    url: "https://gitlab.com/group/sub/project/-/merge_requests/12",
    projectId: 77,
  },
  title: "Ship it",
  description: "Body",
  state: "open",
  author: "ana",
  sourceBranch: "feature/x",
  targetBranch: "main",
  sourceProjectId: 77,
  targetProjectId: 77,
  headSha: "b".repeat(40),
  ci: "failed",
  ciReason: null,
  pipelineUrl: null,
  detailedMergeStatus: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-06T09:00:00Z",
  fetchedAt: "2026-11-08T11:58:30.000Z",
};

function render(overrides: Partial<Pick<MergeRequestBodyProps, "detail" | "failure">> = {}): string {
  return renderToStaticMarkup(
    <MergeRequestBody
      url={detail.identity.url}
      number={detail.identity.number}
      detail={"detail" in overrides ? overrides.detail! : detail}
      failure={overrides.failure ?? null}
      loading={false}
      now={now}
      onRefresh={() => undefined}
      onOpenUrl={() => undefined}
    />,
  );
}

describe("the merge request view", () => {
  it("shows a successfully read merge request with no stale notice", () => {
    const html = render();
    expect(html).toContain("Ship it");
    expect(html).toContain("ana");
    expect(html).toContain("Pipeline failed");
    expect(html).not.toContain("This is what was read");
  });

  it("keeps the read merge request on screen while a failed refresh shows its reason and age", () => {
    const html = render({ failure: { ok: false, reason: "forbidden", message: "GitLab wouldn’t show this project." } });
    expect(html).toContain("Ship it");
    expect(html).toContain("Pipeline failed");
    expect(html).toContain("This merge request isn’t visible");
    expect(html).toContain("GitLab wouldn’t show this project.");
    expect(html).toContain("This is what was read 1 minute ago.");
    expect(html).toContain("Refresh");
  });

  it("drops the retry while GitLab is rate limiting", () => {
    const html = render({ failure: { ok: false, reason: "rateLimited", message: "GitLab is rate limiting requests." } });
    expect(html).toContain("This is what was read 1 minute ago.");
    expect(html).not.toContain(">Refresh<");
  });
});
