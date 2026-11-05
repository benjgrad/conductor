-- UXR-70: a workflow version's optional note, written when it is saved (the Save review dialog,
-- or "Applied proposal: <title>"). The author is the existing `created_by`. Additive: one
-- nullable column; older versions keep null.

-- Up Migration

ALTER TABLE workflow_definition ADD COLUMN note text
  CHECK (note IS NULL OR char_length(note) <= 500);

-- Down Migration

ALTER TABLE workflow_definition DROP COLUMN note;
