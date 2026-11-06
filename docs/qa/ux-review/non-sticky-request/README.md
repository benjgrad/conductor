# Non-sticky request (desktop detail panel)

The desktop panel's request (question, review, failure, plan approval) used to be a pinned pane
above the chat (`.request-slot`: up to 55% of the Messages tab, with its own scroll). It now ends
the conversation, inside the chat's scroll, as on the phone.

`before-*` is this branch with the change reverted; `after-*` is the branch. Mock API
(`VITE_API=mock VITE_MOCK_STATIC=1`), Chrome.

- `*-detail-long-chat-*`: the "Add audit log table" question when the panel opens. Before, the
  question is pinned at the top and the chat is under it; after, it is the last block of the chat,
  which is scrolled to it.
- `*-detail-long-chat-scrolled-up-*`: the same, scrolled up about 700 px. Before, the question
  still covers the top of the panel; after, it has scrolled away and only the history shows
  ("Jump to latest" brings it back).
- `*-detail*`, `*-detail-failed-*`, `*-detail-focus-*`, `*-detail-review-*`: the stock
  `scripts/ui-screenshots.js` shots. The mock sessions have little or no chat, so these change
  little; they show the request's new top border.

The long-chat shots are simulated: the mock's seeded chats are a line or two, so a one-off
Playwright script (not committed) put 30 "Agent message N (simulated history)" blocks into the
log before the shot. Same script and the same injected history for before and after.
