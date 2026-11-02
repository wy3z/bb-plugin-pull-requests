# bb-plugin-pull-requests

A GitHub pull request board for BB, opened from a button in the sidebar
footer. It's a port of the pull request feature in
Zeron (zeronsh, MIT, v0.2.132), rebuilt on BB's plugin SDK.

## Requirements

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
