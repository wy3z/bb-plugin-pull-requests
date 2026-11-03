# bb-plugin-pull-requests

A GitHub pull request board for BB, opened from a button in the sidebar
footer. It's a port of the pull request feature in
Zeron (zeronsh, MIT, v0.2.132), rebuilt on BB's plugin SDK.

## Requirements

- bb >= 0.48.1.
- `gh` on the BB server's machine, signed in to github.com (`gh auth login`).
  The active account is the one used: run `gh auth switch` to change it.

## What was ported

| Zeron source | Here |
| --- | --- |
| `crates/proto/src/change_request_assessment.rs` | `lib/model.ts`: CI state, blockers, attention, actions, missing info |
| `crates/engine/src/source_control.rs` (+ review threads) | `server.ts`: the same GraphQL queries, CI rollup, rename following, error classes, cache and rate-limit pause |
| `crates/ui/src/pull_requests.rs` | `components/pr/board.tsx` |
| `crates/ui/src/pull_request_detail.rs` | `components/pr/detail.tsx` |
| `crates/ui/src/pull_request_handoff.rs` | `lib/handoff.ts` |

Not ported: Zeron's device switcher (BB runs `gh` on the server's machine),
its custom code viewer (BB's `experimental_Diff` is used instead), comment
@-mention completion, and image lightboxes.

## In threads

- **A PRs tray above the composer**, after Cursor's agent-prs-tray: a "PRs"
  chip with the open count opens a tray headed "N Open", newest first, then
  merged and closed ones under "N Done" (three at a time). Each row has
  Cursor's status icon, the title, `#N` and a status word (Draft, Conflicts,
  CI Failing, Ready, Waiting for Reviewers); hovering swaps the word for Add to
  chat, which puts the URL in the composer. A click opens it in the side
  panel, Ctrl or middle-click opens GitHub. The branch's pull request (from
  GitHub PR Status) is highlighted. Status rules live in `lib/status.ts`. The
  chip and tray are styled by this plugin's own `bb-pr-` classes in `app.css`
  (a minimal copy of Cursor's pill and tray look), so no other plugin has to be
  installed.
- **Linking.** `bb pull-requests link <url>` (also `unlink`, `list`) links a
  pull request to the thread running the command, or `--thread <id>`. Links
  live in the thread's plugin metadata, at most 12 per thread.
- **Subscriptions** (moved here from the Subscriptions plugin, GitHub only):
  a thread can follow pull requests and gets one `[Subscription update]`
  message when they change (state, commits, reviews, comments, checks, labels,
  assignees). Subscribe from the **Subscribe** button in the pull request
  viewer's side-panel tab, `bb pull-requests subscribe|unsubscribe <pr…>`,
  `bb pull-requests subscriptions`, or the `pull_request_subscriptions` agent
  tool. A "Listening N" chip above the composer opens a tray of what the
  thread follows; a row opens the pull request, hover swaps the last-check
  time for remove. The checker (`lib/subscriptions.ts`) runs as the `watch`
  background service: every 60s by default, the first check is a silent
  baseline, changes within 10s go out as one message, a message still queued
  is rewritten rather than stacked. Both intervals are plugin settings.- **Links in messages**, after Cursor's composer markdown: any markdown link
  to a github.com pull request gets a live lifecycle icon (open, draft, merged,
  closed), reads `#N` when its text is just the URL or number, and has a hover
  card (title, status, "Opened 4h ago by @x on owner/repo"). A click opens it
  in the side panel; Ctrl or middle-click opens GitHub. BB renders message markdown
  itself, so an app overlay decorates the links in place.
  `::pull-request{url="…"}` on its own line renders the same link.
- **Tabs** read "PR #N", as in Cursor, and the icon takes the lifecycle
  colour (open, draft, merged, closed). Tab titles are plain text, so the
  title ends in an invisible marker that `app.css` matches.
- **Agents** learn both from `skills/pull-requests/SKILL.md`.

## GitHub ownership and the old subscriptions

This plugin is the only watcher and tool for GitHub pull requests. The
Subscriptions plugin now follows Linear issues only, and its "Listening" chip
shows those.

Subscriptions recorded before the split (rows in the Subscriptions plugin's
database) are adopted on this plugin's first start: that database is read
read-only through `bb.server.experimental_dataDir`, each `owner/repo#N` becomes
`https://github.com/owner/repo/pull/N`, and the last snapshot is carried over.
Every adopted pull request is recorded in a `legacy_import` table, so the import
is idempotent, a restart does not duplicate anything, and a subscription removed
here is never resurrected from the old file. Because it reads the file rather
than calling that plugin, it works whether the Subscriptions plugin is enabled,
disabled, or not yet updated, and it never writes to its database. Pending
legacy changes are not carried over.

To keep one pull request pill, turn off GitHub PR Status's own one:
`bb plugin config bb--github-pr-status set showPullRequest false`. That also
drops its Mark ready and Merge buttons above the composer; set it back to
`true` to restore them.

## Icons from Cursor Sidebar

`components/ui/icon*.tsx`, `components/ui/host-icon-names.ts` and
`components/project-icons/` are copied from `bb-plugin-cursor-sidebar`, so
icons render the same in both plugins. The only change is that
`host-icon-names.ts` also exports a `HostIconName` type, so names BB draws
itself type-check. The project-icon colours are copied into `app.css`.

Project icons (glyph, emoji, monogram or uploaded image) are read at runtime
from Cursor Sidebar's `listProjectIcons` RPC and shown in the repository
picker and the detail header. Without that plugin, projects show the folder.
Re-copy these files when Cursor Sidebar's icon code changes.

## How the footer button works

`experimental_sidebarFooter` actions can only open the plugin's settings
page, so the button is registered as a disclosure whose component calls
`useBbNavigate().toPluginPanel(...)` on mount and dismisses itself.
The panel also appears in BB's navigation like any plugin page.

## Develop

```sh
npm install
npx tsc --noEmit -p .
npm test
bb plugin build
bb plugin install . --yes   # first time; then: bb plugin reload pull-requests
```

## Licence

Code ported from Zeron is © 2026 Wing, MIT licence:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
