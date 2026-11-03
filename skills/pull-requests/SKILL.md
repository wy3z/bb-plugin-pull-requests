---
name: pull-requests
description: Link GitHub pull requests to the current BB thread, mention them as clickable links, and subscribe the thread to their updates. Use whenever you open, push to, review, discuss, follow or watch a GitHub pull request in a thread.
---

# Pull requests in BB

The Pull Requests plugin shows a thread's pull requests as pills above its
composer. The user clicks a pill to open the pull request (checks, diff,
conversation) in the thread's side panel.

## Link the pull requests you work on

When you open a pull request, push to one, or start reviewing or fixing one,
link it to this thread:

```sh
bb pull-requests link https://github.com/<owner>/<repo>/pull/<number>
```

- Run it from the thread itself; the command picks up the thread. Outside a
  thread, add `--thread <thread-id>`.
- Linking is idempotent, so linking twice is fine. A thread keeps at most 12;
  the oldest drops off.
- `bb pull-requests list` shows what is linked.
  `bb pull-requests unlink <url>` removes one that no longer belongs here,
  such as a PR you closed in favour of another.
- Only github.com pull request URLs are accepted.

## Mention pull requests in replies

Write an ordinary markdown link to the pull request, in the middle of a
sentence if you like:

```
Fixed in [#123](https://github.com/<owner>/<repo>/pull/123), which replaces
[the old retry logic](https://github.com/<owner>/<repo>/pull/118).
```

The plugin turns it into a link with a live status icon (open, draft, merged,
closed) and a hover card with the title, author and repository. A click opens
it in the side panel. When the link text is just the URL, `123` or `#123`, it
reads `#123`; anything else is kept as written. A bare URL works too.

Use the full github.com pull request URL. Don't put links in code spans or
code blocks, where they stay literal text.

## Follow a pull request (subscriptions)

When the user asks to follow, watch, subscribe to, or stop watching a pull
request, use the `pull_request_subscriptions` tool or the CLI:

```sh
bb pull-requests subscribe https://github.com/<owner>/<repo>/pull/<number>
bb pull-requests unsubscribe <owner>/<repo>#<number>
bb pull-requests subscriptions
```

- IDs: a PR URL, `owner/repo#123`, or a bare number inside a project with a
  GitHub remote. Several at once is fine; at most 100 per thread.
- Subscribing is idempotent. The first successful check is a silent baseline;
  later changes (state, commits, reviews, comments, checks, labels, assignees)
  arrive in this thread as `[Subscription update] …` messages, one message
  covering everything since you last read one.
- "waiting for first check" is normal for about a minute after subscribing.
  "gh is not signed in" means the `gh` CLI on the bb server needs
  `gh auth login`; don't retry in a loop.
- The user can also subscribe from the Subscribe button in the pull request
  viewer, and sees what the thread follows in the Listening chip above the
  composer.

This plugin owns GitHub pull request subscriptions. Subscriptions for Linear
issues belong to the Subscriptions plugin (`thread_subscriptions` /
`bb subscriptions`); GitHub subscriptions the Subscriptions plugin recorded
before the split are imported here automatically on first start, so don't
re-subscribe them.
