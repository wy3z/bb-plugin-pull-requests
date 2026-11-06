// Pull Requests — frontend entry.
//
// A full-page pull request board and detail view (ported from Zeron), opened
// from a button in the sidebar footer. The footer API can't navigate on its
// own, so the button is a disclosure whose component navigates to the page
// and dismisses itself on mount.
import "@wy3z/bb-suite/tokens.css";
import "./app.css";
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  LinkedPullRequestsSegment,
  THREAD_PR_TAB,
  useLinkedPullRequestsVisible,
  useLiveTabTitle,
} from "@/components/pr/pills";
import { starKey } from "@/lib/model";
import type { rpcContract } from "./server";
import { Board, parsePrTabParams, PR_TAB } from "@/components/pr/board";
import { PullRequestDirective, PullRequestLinkDecorator } from "@/components/pr/inline-link";
import { EmptyState } from "@/components/pr/common";
import { DetailPage } from "@/components/pr/detail";
import { ListeningSegment, useListeningVisible } from "@/components/pr/listening";

const PANEL_PATH = "pull-requests";

function useStars() {
  const rpc = useRpc<typeof rpcContract>();
  const [stars, setStars] = useState<string[]>([]);
  const reload = useCallback(() => {
    void rpc.call("preferences_get").then((prefs) => setStars(prefs.stars));
  }, [rpc]);
  useEffect(reload, [reload]);
  // The board and every open pull request tab keep their own copy.
  useRealtime("stars-changed", reload);
  const toggle = useCallback(
    (url: string) => {
      const key = starKey(url);
      setStars((current) => (current.includes(key) ? current.filter((s) => s !== key) : [...current, key]));
      void rpc.call("star_toggle", { key }).then((result) => setStars(result.stars));
    },
    [rpc],
  );
  return { stars, toggle };
}

function PullRequestsPage({ subPath }: { subPath: string }) {
  const { stars, toggle } = useStars();
  const segments = subPath.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] === "pr" && segments.length === 4) {
    const number = Number(segments[3]);
    if (Number.isInteger(number) && number > 0) {
      return (
        <DetailPage
          key={subPath}
          owner={segments[1]!}
          name={segments[2]!}
          number={number}
          stars={stars}
          onToggleStar={toggle}
        />
      );
    }
  }
  return <Board stars={stars} onToggleStar={toggle} />;
}

/** One pull request in the side panel, opened from a board row or a pill. */
function PullRequestTab({
  params,
  tab,
  threadId,
}: {
  params: unknown;
  tab: typeof PR_TAB | typeof THREAD_PR_TAB;
  threadId?: string;
}) {
  const { stars, toggle } = useStars();
  const pr = parsePrTabParams(params);
  useLiveTabTitle(tab, pr);
  if (pr === null) {
    return <EmptyState icon="Info" title="Nothing to show" body="Open a pull request from the board." />;
  }
  return (
    <DetailPage
      key={`${pr.owner}/${pr.name}/${pr.number}`}
      owner={pr.owner}
      name={pr.name}
      number={pr.number}
      stars={stars}
      onToggleStar={toggle}
      layout="panel"
      threadId={threadId}
    />
  );
}

function OpenPullRequests({ dismiss }: { dismiss: () => void }) {
  const navigate = useBbNavigate();
  useEffect(() => {
    navigate.toPluginPanel(PANEL_PATH);
    dismiss();
  }, [navigate, dismiss]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pull-requests",
    title: "Pull requests",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: PullRequestsPage,
  });
  app.slots.experimental_tab({
    ...PR_TAB,
    title: "Pull request",
    icon: "GitPullRequest",
    layout: "flush",
    component: ({ params }) => <PullRequestTab params={params} tab={PR_TAB} />,
  });
  // The same tab inside a thread, opened from a composer pill or a reply.
  app.slots.experimental_tab({
    ...THREAD_PR_TAB,
    title: "Pull request",
    icon: "GitPullRequest",
    layout: "flush",
    component: ({ params, threadId }) => <PullRequestTab params={params} tab={THREAD_PR_TAB} threadId={threadId} />,
  });
  app.slots.experimental_threadContextSegment({
    id: "linked-pull-requests",
    title: "Linked pull requests",
    // Beside GitHub PR Status's own segment for the branch's pull request.
    group: "2_pullRequest",
    order: 20,
    summary: LinkedPullRequestsSegment,
    useVisible: useLinkedPullRequestsVisible,
  });
  app.slots.experimental_threadContextSegment({
    id: "listening",
    // The GitHub subscriptions this plugin owns; the Subscriptions plugin's
    // own chip is Linear only.
    title: "Pull request subscriptions",
    group: "2_pullRequest",
    order: 30,
    summary: ListeningSegment,
    useVisible: useListeningVisible,
  });
  app.slots.messageDirective({
    id: "pull-request",
    component: PullRequestDirective,
  });
  // Decorates plain pull request links in messages, as Cursor does.
  app.slots.experimental_appOverlay({
    id: "pull-request-links",
    component: PullRequestLinkDecorator,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "pull-requests",
    label: "Pull requests",
    icon: "GitPullRequest",
    component: OpenPullRequests,
  });
});
