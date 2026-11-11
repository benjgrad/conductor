-- R11 (ADR-0037 Q1 amended): GitHub webhooks bring a matching session's next condition / watch
-- check forward to now; polling stays the backstop. `github_webhook` holds the account's signing
-- secret (plaintext: HMAC needs the key, TD-222: encrypt at rest). `github_webhook_delivery`
-- deduplicates deliveries by GitHub's `X-GitHub-Delivery` GUID; rows older than 7 days are pruned
-- by the route. docs/design/02-data-model.md describes both.

-- Up Migration

CREATE TABLE github_webhook (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_webhook_delivery (
  delivery_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  event text NOT NULL,
  received_at timestamptz NOT NULL,
  sessions_nudged integer NOT NULL DEFAULT 0
);
CREATE INDEX github_webhook_delivery_received_at_idx ON github_webhook_delivery (received_at);
CREATE INDEX github_webhook_delivery_account_idx ON github_webhook_delivery (account_id, received_at);

-- Down Migration

DROP TABLE github_webhook_delivery;
DROP TABLE github_webhook;
