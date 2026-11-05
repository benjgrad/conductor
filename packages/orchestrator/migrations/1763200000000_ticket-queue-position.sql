-- 06 §Queue order: a ticket's hand-set place in the Queued column (1 = picked up first), set by
-- dragging a card or the MCP `reorder_queue` tool. NULL = not reordered: after every ranked ticket,
-- by priority then age, which is the order before this column existed. The claim clears it.
-- Additive: one nullable column and a partial index for the claim's ORDER BY.

-- Up Migration

ALTER TABLE ticket ADD COLUMN queue_position integer
  CHECK (queue_position IS NULL OR queue_position > 0);

CREATE INDEX ticket_ready_queue_idx ON ticket (account_id, queue_position, priority DESC, created_at)
  WHERE status = 'ready';

-- Down Migration

DROP INDEX ticket_ready_queue_idx;
ALTER TABLE ticket DROP COLUMN queue_position;
