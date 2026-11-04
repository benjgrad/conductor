-- Questions UX (docs/design/06-human-input.md §Agent question options): the clickable choices an
-- agent attached to its `ask_user` question, `{multi_select, items: [{label, description?}]}`
-- (QuestionOptionsSchema in @conductor/shared). NULL for every other request and for questions
-- without options. Additive and nullable: older rows and older daemons are unaffected. The row
-- type is in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.

-- Up Migration

ALTER TABLE input_request ADD COLUMN options jsonb;

-- Down Migration

ALTER TABLE input_request DROP COLUMN options;
