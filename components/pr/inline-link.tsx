// Pull request links in chat, after Cursor's composer markdown
// (pull-request-link-content, agent-pr-status-icon and
// pull-request-link-hover-card in workbench.glass.main.js): an ordinary
// inline link led by a 13px lifecycle icon, labelled `#N` when the link text
// is just the URL or number, with a hover card for the title, status, author
// and repository.
//
// BB renders message markdown itself, so plain links are decorated in place by
// an app overlay that watches the message column; `::pull-request{url}` renders
// the same link directly.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { compactRelativeTime } from "@/lib/model";
import { LIFECYCLE, lifecycle } from "@/lib/status";
import type { PullRequestSummary } from "../../server";
import { Avatar } from "./common";
import { isPullRequestUrl, openInThreadPanel, useSummaries } from "./pills";
import { OPEN_PULL_REQUEST_EVENT, openPullRequestUrl } from "./open-event";

const PR_PATH_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/;

/** The canonical pull request URL an href points at, or null. */
export function pullRequestHref(href: string): { url: string; number: number } | null {
  const match = PR_PATH_RE.exec(href.trim());
  if (!match) return null;
  return { url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`, number: Number(match[3]) };
}

/** Cursor's rule: the link text says nothing beyond the URL, so show `#N`. */
function isBareLabel(text: string, pr: { url: string; number: number }): boolean {
  const value = text.trim();
  if (value === "" || value === String(pr.number) || value === `#${pr.number}`) return true;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return pullRequestHref(candidate)?.url === pr.url;
}

export function PrStatusIcon({ summary }: { summary: PullRequestSummary | undefined }) {
  const state = summary ? lifecycle(summary) : null;
  return (
    <span
      className="bb-pr-link__icon"
      data-status={state ?? "unknown"}
      role="img"
      aria-label={state ? `PR ${LIFECYCLE[state].label.toLowerCase()}` : "GitHub pull request"}
    >
      <Icon name={state ? LIFECYCLE[state].icon : "Github"} aria-hidden />
    </span>
  );
}

function HoverCardBody({ url, summary }: { url: string; summary: PullRequestSummary | undefined }) {
  const number = pullRequestHref(url)?.number;
  if (!summary) return <div className="bb-pr-card__title">Loading #{number}…</div>;
  const state = lifecycle(summary);
  return (
    <>
      <div className="bb-pr-card__heading">
        <span className="bb-pr-card__title">{summary.title}</span>{" "}
        <span className="bb-pr-card__number">#{summary.number}</span>{" "}
        <span className="bb-pr-card__badge" data-status={state}>
          <Icon name={LIFECYCLE[state].icon} aria-hidden />
          {LIFECYCLE[state].label}
        </span>
      </div>
      {summary.createdAt && summary.author ? (
        <div className="bb-pr-card__meta">
          <span className="bb-pr-card__opened">
            Opened {compactRelativeTime(summary.createdAt)} by
            <span title={summary.author} aria-label={summary.author} role="img">
              <Avatar login={summary.author} size={16} />
            </span>
            on
          </span>
          <span className="bb-pr-card__repo">{summary.repository}</span>
        </div>
      ) : null}
    </>
  );
}

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;

/** One floating card per surface, anchored below-left of the hovered link. */
function useHoverCard() {
  const [target, setTarget] = useState<{ anchor: HTMLElement; url: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  const show = useCallback((anchor: HTMLElement, url: string) => {
    clear();
    timer.current = window.setTimeout(() => setTarget({ anchor, url }), OPEN_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setTarget(null), CLOSE_DELAY_MS);
  }, []);
  useEffect(() => clear, []);
  return { target, show, hide, keep: clear };
}

function HoverCard({
  anchor,
  url,
  summary,
  onEnter,
  onLeave,
}: {
  anchor: HTMLElement;
  url: string;
  summary: PullRequestSummary | undefined;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 320;
    const height = ref.current?.offsetHeight ?? 80;
    const below = rect.bottom + 6 + height <= window.innerHeight;
    setPosition({
      top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }, [anchor, summary]);
  return createPortal(
    <div
      ref={ref}
      className="bb-pr-card"
      role="tooltip"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <HoverCardBody url={url} summary={summary} />
    </div>,
    document.body,
  );
}

function InlineLink({ url, label }: { url: string; label: ReactNode }) {
  const summary = useSummaries([url]).get(url);
  const card = useHoverCard();
  return (
    <>
      <a
        href={url}
        className="bb-pr-link bb-pr-link--own"
        data-bb-pr-url={url}
        onMouseEnter={(event) => card.show(event.currentTarget, url)}
        onMouseLeave={card.hide}
      >
        <PrStatusIcon summary={summary} />
        {label}
      </a>
      {card.target ? (
        <HoverCard {...card.target} summary={summary} onEnter={card.keep} onLeave={card.hide} />
      ) : null}
    </>
  );
}

export function PullRequestDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const pr = pullRequestHref(attributes.url ?? "");
  if (!pr || !isPullRequestUrl(pr.url)) return <code>{source}</code>;
  const text = attributes.label?.trim();
  return <InlineLink url={pr.url} label={text && !isBareLabel(text, pr) ? text : `#${pr.number}`} />;
}

// ---- Plain markdown links in messages ------------------------------------

interface Decorated {
  anchor: HTMLAnchorElement;
  iconHost: HTMLSpanElement;
  url: string;
}

/** The thread a message link sits in: its pane's thread, else the route's. */
function threadIdFor(anchor: Element): string | null {
  const pane = anchor.closest<HTMLElement>("[data-thread-id]");
  if (pane?.dataset.threadId) return pane.dataset.threadId;
  return /\/threads\/(thr_[A-Za-z0-9]+)/.exec(window.location.pathname)?.[1] ?? null;
}

const MESSAGE_LINKS =
  '[data-message-column] a[href^="https://github.com/"], [data-message-column] a[data-bb-pr-link]';
const OURS = ["bb-pr-link__slot", "bb-pr-link__label"];
const MARK = "bbPrLink";

function linkText(anchor: HTMLAnchorElement): string {
  let text = "";
  for (const node of Array.from(anchor.childNodes)) {
    if (node instanceof Element && OURS.some((name) => node.classList.contains(name))) continue;
    text += node.textContent ?? "";
  }
  return text;
}

function strip(anchor: HTMLAnchorElement) {
  for (const child of Array.from(anchor.children)) {
    if (OURS.some((name) => child.classList.contains(name))) child.remove();
  }
  anchor.classList.remove("bb-pr-link", "bb-pr-link--compact");
  anchor.style.removeProperty("--bb-pr-font-size");
  delete anchor.dataset[MARK];
}

/** Adds an icon (and a `#N` label when the text is bare) to one anchor. */
function decorate(anchor: HTMLAnchorElement): Decorated | null {
  if (anchor.dataset[MARK] !== undefined || anchor.closest("pre, code, .bb-pr-link--own")) return null;
  const pr = pullRequestHref(anchor.getAttribute("href") ?? "");
  if (!pr) return null;
  anchor.dataset[MARK] = pr.url;
  anchor.classList.add("bb-pr-link");
  const iconHost = document.createElement("span");
  iconHost.className = "bb-pr-link__slot";
  anchor.prepend(iconHost);
  if (isBareLabel(linkText(anchor), pr)) {
    // Leave React's text node alone (it may still be streaming) and show the
    // label beside it; CSS hides the original text.
    anchor.style.setProperty("--bb-pr-font-size", getComputedStyle(anchor).fontSize);
    anchor.classList.add("bb-pr-link--compact");
    const label = document.createElement("span");
    label.className = "bb-pr-link__label";
    label.textContent = `#${pr.number}`;
    iconHost.after(label);
  }
  return { anchor, iconHost, url: pr.url };
}

/**
 * App-wide: finds pull request links in message markdown and portals a live
 * status icon into each, with the hover card and side-panel click.
 */
export function PullRequestLinkDecorator() {
  const [links, setLinks] = useState<readonly Decorated[]>([]);
  useEffect(() => {
    let frame = 0;
    const scan = () => {
      frame = 0;
      const added: Decorated[] = [];
      const dropped = new Set<HTMLAnchorElement>();
      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>(MESSAGE_LINKS))) {
        const mark = anchor.dataset[MARK];
        if (mark !== undefined) {
          const pr = pullRequestHref(anchor.getAttribute("href") ?? "");
          const compact = anchor.classList.contains("bb-pr-link--compact");
          if (pr && pr.url === mark && isBareLabel(linkText(anchor), pr) === compact) continue;
          strip(anchor);
          dropped.add(anchor);
        }
        const entry = decorate(anchor);
        if (entry) added.push(entry);
      }
      setLinks((current) => {
        const live = current.filter(
          (entry) => !dropped.has(entry.anchor) && entry.anchor.isConnected && entry.iconHost.isConnected,
        );
        return added.length === 0 && live.length === current.length ? current : [...live, ...added];
      });
    };
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = window.requestAnimationFrame(scan);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    scan();
    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  const urls = [...new Set(links.map((entry) => entry.url))];
  const summaries = useSummaries(urls);
  const card = useHoverCard();

  const navigate = useBbNavigate();
  const latest = useRef({ summaries, card, navigate });
  latest.current = { summaries, card, navigate };

  // A plain click opens the thread's side panel and nothing else; Ctrl/Cmd,
  // Shift and middle clicks keep the browser's behaviour. Window capture runs
  // before BB's own link handling.
  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a.bb-pr-link");
      const url = anchor ? (anchor.dataset[MARK] ?? anchor.dataset.bbPrUrl) : undefined;
      if (!anchor || !url) return;
      const opened = openInThreadPanel(threadIdFor(anchor), url, latest.current.summaries.get(url), () =>
        latest.current.navigate.openUrl(url),
      );
      if (!opened) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("click", intercept, true);
    return () => window.removeEventListener("click", intercept, true);
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const pr = pullRequestHref(openPullRequestUrl((event as CustomEvent<unknown>).detail) ?? "");
      const source = event.target instanceof Element ? event.target : null;
      const threadId = source ? threadIdFor(source) : null;
      if (!pr || threadId === null) return;
      const opened = openInThreadPanel(threadId, pr.url, latest.current.summaries.get(pr.url), () =>
        latest.current.navigate.openUrl(pr.url),
      );
      if (opened) event.preventDefault();
    };
    window.addEventListener(OPEN_PULL_REQUEST_EVENT, open);
    return () => window.removeEventListener(OPEN_PULL_REQUEST_EVENT, open);
  }, []);

  // Hover listeners live on anchors React doesn't own, so attach them by hand.
  useEffect(() => {
    const cleanups = links.map(({ anchor, url }) => {
      const enter = () => latest.current.card.show(anchor, url);
      const leave = () => latest.current.card.hide();
      anchor.addEventListener("mouseenter", enter);
      anchor.addEventListener("mouseleave", leave);
      return () => {
        anchor.removeEventListener("mouseenter", enter);
        anchor.removeEventListener("mouseleave", leave);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [links]);

  return (
    <>
      {links.map(({ iconHost, url }, index) =>
        createPortal(<PrStatusIcon summary={summaries.get(url)} />, iconHost, `${url}#${index}`),
      )}
      {card.target ? (
        <HoverCard
          {...card.target}
          summary={summaries.get(card.target.url)}
          onEnter={card.keep}
          onLeave={card.hide}
        />
      ) : null}
    </>
  );
}
