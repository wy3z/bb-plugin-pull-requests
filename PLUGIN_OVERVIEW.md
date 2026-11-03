Your open GitHub pull requests in BB, grouped by what each one needs from you.

## What you get

- A **Pull requests** button in the sidebar footer that opens the board.
- A board for one repository with Authored, Reviewing and All views, search,
  sorting, and Needs you and Starred filters. Rows are grouped into Needs
  attention, Awaiting review, Approved and Drafts.
- A page for each pull request with its status, checks, assessment and
  description, every changed file as a diff, and the conversation, reviews
  and inline threads, with a box for posting a comment.
- Hand off: start a new thread with a prompt to review the PR, address
  feedback, fix failing checks or resolve conflicts. The prompt is put in
  the composer for you to read before sending.
- A **Listening** chip with the GitHub pull requests the thread follows, and
  the `[Subscription update]` messages they produce. This plugin is the only
  GitHub watcher; Linear subscriptions stay with the Subscriptions plugin.

## How it works

Every request goes through the GitHub CLI (`gh`) already signed in on the BB
server's machine, with prompts disabled. Results are cached for a minute, and
reads pause for 15 minutes if GitHub's rate limit is hit. The only write is a
comment, and only when you press Comment.
