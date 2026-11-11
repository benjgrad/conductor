# GitHub webhooks: react to CI, reviews and merges within seconds

Without a webhook, conductor polls GitHub. A PR gate waiting on its conditions (`pr_checks_green`, `pr_approvals`, `pr_mergeable` …) and a watched column such as In review check again every 1–15 minutes. Merges that conductor performs itself already wake the other watched tickets on the repo at once. That leaves CI finishing, a review landing, or a merge someone did on github.com: these wait for the next poll.

A GitHub webhook removes that wait. When GitHub reports a finished check suite or check run, a PR update, a review or a merge, conductor brings the matching tickets' next check forward to now, and they are re-evaluated within a second or two. The webhook never decides anything. The normal evaluation runs, and polling stays on as the backstop. A repo without a webhook behaves exactly as before. Design: [ADR-0037](../adr/0037-workflow-primitives-for-self-healing-process.md) Q1 (amended by R11), [10 §GitHub webhooks](../design/10-contracts.md#github-webhooks).

**Before you start: GitHub has to reach conductor.** That means a hosted server (`CONDUCTOR_AUTH=password`, e.g. `https://conductor.gradyserver.com`). A local (`localhost`) conductor would need a tunnel, with the tunnel's host added to `CONDUCTOR_ALLOWED_HOSTS`.

## 1. Get the payload URL and a secret

The secret belongs to your conductor account. Every repo you add the webhook to uses the same URL and secret. Get them in one of two ways.

**On the server** (the operator; the user must own exactly one account):

```bash
cdc exec orchestrator node dist/admin-cli.js github-webhook you@example.com
```

It prints:

```
payload URL: https://conductor.example.com/api/webhooks/github/<account id>
content type: application/json
secret: <64 hex characters>
events: Check runs, Check suites, Pull requests, Pull request reviews
```

**Over the API** (signed in, from the browser's console or with your session cookie): `POST /api/github-webhook/secret` with body `{}` returns `{url, secret}`. `GET /api/github-webhook` shows the URL, whether a secret is set and when the last delivery arrived. It never shows the secret.

The secret is shown once. Each run makes a new one, and the old one stops working at once, so update every repo's webhook after rotating.

## 2. Add the webhook to the repo

On github.com, open the repo, then **Settings → Webhooks → Add webhook**. You need admin rights on the repo. An organization webhook (**org Settings → Webhooks**) works the same way and covers every repo in the org.

| Field | Value |
|---|---|
| Payload URL | the `payload URL` printed above |
| Content type | **`application/json`** (GitHub's default, `application/x-www-form-urlencoded`, is refused with 415) |
| Secret | the `secret` printed above |
| SSL verification | Enable |
| Which events? | **Let me select individual events**, then tick **Check runs**, **Check suites**, **Pull requests** and **Pull request reviews**, and untick **Pushes** |
| Active | ticked |

Click **Add webhook**. GitHub sends a `ping` at once.

## 3. Check it works

On the webhook's page, open **Recent Deliveries**:
- the `ping` should show a green tick and response `200`;
- after the next CI run on a conductor PR, the `check_suite` deliveries should show `202`. The response body says how many tickets were woken (`"nudged": 1`), or `"ignored": true` for an event that settles nothing (a check that only started, a label change).

`GET /api/github-webhook` now shows `last_delivery_at`.

## Troubleshooting

| Response | Meaning |
|---|---|
| `401 invalid signature` | The secret in GitHub doesn't match conductor's. It was rotated since, or it was pasted with a space. Paste the current one again, or rotate and update every repo |
| `404` | No secret is set for that account yet (step 1), or the URL's account id is wrong |
| `415` | The content type is form-encoded: switch it to `application/json` |
| `403` | The request didn't reach conductor under its public host. Check the payload URL uses `CONDUCTOR_PUBLIC_URL`'s host |
| `200 "duplicate": true` | GitHub redelivered a delivery conductor already handled (e.g. **Redeliver**). Nothing happens the second time; this is expected |
| `202 "nudged": 0` | The event was valid, but no ticket on that repo was waiting on that PR or branch right then |

## What a delivery wakes

- **`check_run` / `check_suite` `completed`, `pull_request`, `pull_request_review`.** A ticket on the same repo whose conductor PR or branch the event names gets an immediate check:
  - a PR gate's conditions, when it is waiting on them;
  - its watch, when it sits in a watched column such as In review.
- **A merged PR** (`pull_request` `closed` with `merged: true`) also wakes every watched ticket on the repo, because the default branch moved. A PR that no longer merges is then sent back at once instead of at the next poll.
- **Deliveries are deduplicated** by GitHub's `X-GitHub-Delivery` id for a week.

Removing the webhook from the repo (or never adding one) just means conductor polls, as before.
