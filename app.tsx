// Pull Requests — frontend entry.
//
// A full-page pull request board and detail view (ported from Zeron), opened
// from a button in the sidebar footer. The footer API can't navigate on its
// own, so the button is a disclosure whose component navigates to the page
// and dismisses itself on mount.
import "./app.css";
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { starKey } from "@/lib/model";
import type { rpcContract } from "./server";
import { Board } from "@/components/pr/board";
import { DetailPage } from "@/components/pr/detail";

const PANEL_PATH = "pull-requests";

function useStars() {
  const rpc = useRpc<typeof rpcContract>();
  const [stars, setStars] = useState<string[]>([]);
  useEffect(() => {
    void rpc.call("preferences_get").then((prefs) => setStars(prefs.stars));
  }, [rpc]);
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
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "pull-requests",
    label: "Pull requests",
    icon: "GitPullRequest",
    component: OpenPullRequests,
  });
});
