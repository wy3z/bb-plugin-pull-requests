import { describe, expect, it } from "vitest";
import { canonicalPullRequestUrl } from "../../server";
import { parsePrTabParams, prTabParams } from "./board";
import {
  gitlabTabParams,
  mergeRequestPagePath,
  mergeRequestTabTitle,
  parseGitLabTabParams,
  parseMergeRequestPagePath,
} from "./change-request";
import { pullRequestHref } from "./inline-link";
import { isPullRequestUrl } from "./pills";

const MR = "https://gitlab.com/group/sub/project/-/merge_requests/12";

describe("GitHub routing is unchanged", () => {
  it("still canonicalises and parses github.com pull requests", () => {
    expect(canonicalPullRequestUrl(" https://github.com/Owner/Repo/pull/7/ ")).toBe("https://github.com/Owner/Repo/pull/7");
    expect(prTabParams("https://github.com/Owner/Repo/pull/7")).toEqual({ owner: "Owner", name: "Repo", number: 7 });
    expect(parsePrTabParams({ owner: "Owner", name: "Repo", number: 7 })).toEqual({ owner: "Owner", name: "Repo", number: 7 });
    expect(pullRequestHref("https://github.com/o/r/pull/3#discussion")).toEqual({ url: "https://github.com/o/r/pull/3", number: 3 });
  });

  it("keeps persisted GitHub tabs away from the GitLab parser", () => {
    expect(parseGitLabTabParams({ owner: "Owner", name: "Repo", number: 7 })).toBeNull();
  });
});

describe("GitLab never reaches a GitHub parser", () => {
  it("is rejected by every GitHub URL check", () => {
    expect(canonicalPullRequestUrl(MR)).toBeNull();
    expect(pullRequestHref(MR)).toBeNull();
    expect(isPullRequestUrl(MR)).toBe(false);
  });

  it("uses its own tab params that the GitHub tab parser ignores", () => {
    const params = gitlabTabParams(MR, "glab:host1")!;
    expect(params).toEqual({ provider: "gitlab", url: MR, connection: "glab:host1" });
    expect(parsePrTabParams(params)).toBeNull();
    expect(parseGitLabTabParams({ ...params })).toEqual(params);
    expect(mergeRequestTabTitle(MR)).toBe("MR !12");
  });

  it("round-trips the full-page path for nested projects", () => {
    const params = gitlabTabParams(MR, "glab:host1")!;
    const segments = mergeRequestPagePath(params).split("/").filter(Boolean).map(decodeURIComponent);
    expect(parseMergeRequestPagePath(segments)).toEqual(params);
  });

  it("refuses tab params without a usable connection or MR URL", () => {
    expect(gitlabTabParams(MR, "glab:../x")).toBeNull();
    expect(gitlabTabParams("https://gitlab.com/group/project/-/issues/1", "glab:host1")).toBeNull();
    expect(parseGitLabTabParams({ provider: "github", url: MR, connection: "glab:host1" })).toBeNull();
  });
});
