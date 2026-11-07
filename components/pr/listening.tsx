import { shortAgo } from "@wy3z/bb-suite/time";
// Subscriptions in the UI: a "Listening N" chip above the composer, after
// Cursor's subscriptions pill, opening a tray of the pull requests this thread
// follows; and the Subscribe button in the pull request viewer.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract, SubscriptionView } from "../../server";
import { prTabParams } from "./board";
import { useOpenPullRequest } from "./pills";

const FIRST_PAGE = 5;
const NEXT_PAGE = 8;
const CHANGED = "subscriptions-changed";

/** A thread's subscriptions, kept fresh over realtime and reconnects. */
export function useSubscriptions(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<SubscriptionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const request = useRef(0);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(async () => {
    if (!threadId) return;
    const id = ++request.current;
    try {
      const result = await rpc.call("subscriptions_list", { threadId });
      if (id === request.current) {
        setItems(result.subscriptions);
        setLoaded(true);
      }
    } catch {
      /* Keep the last known list during disconnects. */
    }
  }, [rpc, threadId]);
  useEffect(() => {
    setItems([]);
    setLoaded(false);
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);
  useRealtime(CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) void refresh();
  });
  const change = useCallback(
    async (urls: string[], add: boolean) => {
      if (!threadId) return;
      await rpc.call(add ? "subscribe" : "unsubscribe", { threadId, urls });
      await refresh();
    },
    [rpc, threadId, refresh],
  );
  return { items, loaded, change };
}

function ago(now: number, at: number): string {
  return shortAgo(at, now);
}

/** The chip above the composer and its tray. */
export function ListeningSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const { items, change } = useSubscriptions(threadId);
  const openPullRequest = useOpenPullRequest();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(FIRST_PAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setError(null);
  }, [threadId]);
  useEffect(() => {
    if (!open) {
      setShown(FIRST_PAGE);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!items.length) return null;
  const count = items.length;
  const hidden = Math.max(0, count - shown);

  const remove = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      await change([url], false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the subscription. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bb-pr-chips" data-bb-plugin-root="" ref={root}>
      <div className="bb-pr-chips__row">
        <button
          type="button"
          className="bb-pr-chips__pill"
          data-group="listening"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`View subscriptions (${count})`}
          title={`View subscriptions (${count})`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="bb-pr-chips__label">Listening</span>
          <span className="bb-pr-chips__count">{count}</span>
        </button>
      </div>
      {open ? (
        <div className="bb-pr-tray" role="menu" aria-label="Subscriptions">
          <div className="bb-pr-tray__header">
            <span className="bb-pr-tray__title">
              {count} {count === 1 ? "Subscription" : "Subscriptions"}
            </span>
            <button
              type="button"
              className="bb-pr-tray__icon"
              aria-label="Minimize"
              title="Minimize (Esc)"
              onClick={() => setOpen(false)}
            >
              <Icon name="Minus" />
            </button>
          </div>
          <div className="bb-pr-tray__rows">
            {items.slice(0, shown).map((item) => {
              const { owner, name, number } = prTabParams(item.url);
              const label = `PR activity on #${number}`;
              const state = item.error ?? item.snapshot?.state ?? "Checking";
              return (
                <div
                  key={item.url}
                  role="menuitem"
                  tabIndex={0}
                  aria-label={label}
                  className="bb-pr-tray__row"
                  title={`${item.snapshot?.title ? `${item.snapshot.title} · ` : ""}${owner}/${name}#${number}`}
                  onClick={() => {
                    setOpen(false);
                    openPullRequest(item.url, undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpen(false);
                      openPullRequest(item.url, undefined);
                    }
                  }}
                >
                  <span className="bb-pr-tray__leading" aria-hidden="true">
                    <Icon name="Github" />
                  </span>
                  <span className="bb-pr-tray__label">
                    PR activity <span className="bb-pr-listening__connective">on</span> #{number}
                  </span>
                  <span
                    className="bb-pr-tray__description"
                    data-error={item.error ? "" : undefined}
                  >
                    {state}
                  </span>
                  <span className="bb-pr-tray__end">
                    <span className="bb-pr-tray__actions">
                      <button
                        type="button"
                        disabled={busy}
                        className="bb-pr-tray__icon"
                        aria-label={`Remove subscription ${label}`}
                        title="Remove Subscription"
                        onClick={(event) => {
                          event.stopPropagation();
                          void remove(item.url);
                        }}
                      >
                        <Icon name="Trash2" />
                      </button>
                    </span>
                    <span className="bb-pr-tray__meta">{item.checkedAt ? ago(now, item.checkedAt) : ""}</span>
                  </span>
                </div>
              );
            })}
            {hidden > 0 ? (
              <button
                type="button"
                className="bb-pr-tray__more"
                aria-label={`Show ${Math.min(hidden, NEXT_PAGE)} more subscriptions`}
                onClick={() => setShown((value) => value + NEXT_PAGE)}
              >
                More
              </button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="bb-pr-listening__error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Segment visibility: the thread follows at least one pull request. */
export function useListeningVisible({ threadId }: { threadId: string }): boolean {
  return useSubscriptions(threadId).items.length > 0;
}

/** The viewer's toggle: follow this pull request from the thread the panel belongs to. */
export function SubscribeButton({ threadId, url }: { threadId: string; url: string }) {
  const { items, loaded, change } = useSubscriptions(threadId);
  const [busy, setBusy] = useState(false);
  const subscribed = items.some((item) => item.url.toLowerCase() === url.toLowerCase());
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-8 gap-1.5 text-xs", subscribed && "text-[color:var(--bbs-text-primary)]")}
      aria-pressed={subscribed}
      disabled={!loaded || busy}
      onClick={() => {
        setBusy(true);
        change([url], !subscribed)
          .then(() =>
            toast(subscribed ? "Unsubscribed" : "Subscribed: this thread gets a message when the pull request changes"),
          )
          .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "Couldn’t change the subscription"))
          .finally(() => setBusy(false));
      }}
    >
      <Icon name={subscribed ? "BellRing" : "Bell"} className="size-3.5" />
      {subscribed ? "Subscribed" : "Subscribe"}
    </Button>
  );
}
