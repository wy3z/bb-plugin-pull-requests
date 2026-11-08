import { describe, expect, it } from "vitest";
import { FAILURE_TITLE, refreshNotice } from "./change-request-notice";

describe("a failed refresh over retained merge request detail", () => {
  const detail = { fetchedAt: "2026-11-08T11:58:30.000Z" };
  const now = Date.parse("2026-11-08T12:00:00.000Z");

  it("shows the failure and how old the retained data is, together", () => {
    const notice = refreshNotice({ ok: false, reason: "forbidden", message: "GitLab wouldn’t show this project." }, detail, now);
    expect(notice).toEqual({
      title: "This merge request isn’t visible",
      message: "GitLab wouldn’t show this project.",
      freshness: "This is what was read 1 minute ago.",
    });
  });

  it("names a failure the copy doesn’t know instead of dropping it", () => {
    expect(refreshNotice({ ok: false, reason: "unknown", message: "Boom." }, detail, now)?.title).toBe("Couldn’t refresh this merge request");
  });

  it("stays out of the way on a first load and without retained data", () => {
    expect(refreshNotice({ ok: false, reason: "network", message: "Offline." }, null, now)).toBeNull();
    expect(refreshNotice(null, detail, now)).toBeNull();
  });

  it("covers every reason the detail read can report", () => {
    for (const reason of ["cliMissing", "authentication", "forbidden", "notFound", "hostOffline", "rateLimited", "network", "unsupportedHost"] as const) {
      expect(FAILURE_TITLE[reason]).toBeTruthy();
    }
  });
});
