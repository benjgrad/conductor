-- M2-T21 (ADR-0012 §Tenancy; pays the child-table half of TD-109): `session`, `input_request`,
-- `event` and `outbox` rows take their account from the row they belong to, never from the
-- temporary `local` default. Until now every engine write (the claim's and the reopen's sessions,
-- every event, input request and outbox row) silently landed in `local`, so the board, its SSE
-- stream and the session routes could not be filtered by account.
--
-- A BEFORE INSERT trigger derives `account_id`:
--   session        ← its ticket
--   input_request  ← its session
--   event          ← its session, else the ticket named by `payload.ticket_id` (ticket events)
--   outbox         ← its session (session-less rows, the Web Push ones, set it themselves)
-- An explicit `account_id` that disagrees with the parent's is refused, so a write can never put
-- a child row in another account. The `local` defaults on these four tables are dropped: a row
-- with no parent and no explicit account fails NOT NULL instead of joining `local`.
-- (`ticket`, `machine`, `machine_repo` and `workflow_definition` keep theirs for now: every
-- writer sets them explicitly; TD-109 stays open for them.)

-- Up Migration

CREATE FUNCTION conductor_account_from_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent uuid;
BEGIN
  IF TG_TABLE_NAME = 'session' THEN
    SELECT t.account_id INTO parent FROM ticket t WHERE t.id = NEW.ticket_id;
  ELSIF TG_TABLE_NAME = 'input_request' THEN
    SELECT s.account_id INTO parent FROM session s WHERE s.id = NEW.session_id;
  ELSIF TG_TABLE_NAME = 'event' THEN
    IF NEW.session_id IS NOT NULL THEN
      SELECT s.account_id INTO parent FROM session s WHERE s.id = NEW.session_id;
    ELSIF NEW.payload ? 'ticket_id' THEN
      SELECT t.account_id INTO parent FROM ticket t WHERE t.id::text = NEW.payload->>'ticket_id';
    END IF;
  ELSIF TG_TABLE_NAME = 'outbox' THEN
    IF NEW.session_id IS NOT NULL THEN
      SELECT s.account_id INTO parent FROM session s WHERE s.id = NEW.session_id;
    END IF;
  END IF;
  IF parent IS NOT NULL THEN
    IF NEW.account_id IS NOT NULL AND NEW.account_id <> parent THEN
      RAISE EXCEPTION '% row in account % belongs to account %', TG_TABLE_NAME, NEW.account_id,
        parent USING ERRCODE = 'check_violation';
    END IF;
    NEW.account_id := parent;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE session ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE input_request ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE event ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE outbox ALTER COLUMN account_id DROP DEFAULT;

CREATE TRIGGER session_account_from_parent BEFORE INSERT ON session
  FOR EACH ROW EXECUTE FUNCTION conductor_account_from_parent();
CREATE TRIGGER input_request_account_from_parent BEFORE INSERT ON input_request
  FOR EACH ROW EXECUTE FUNCTION conductor_account_from_parent();
CREATE TRIGGER event_account_from_parent BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION conductor_account_from_parent();
CREATE TRIGGER outbox_account_from_parent BEFORE INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION conductor_account_from_parent();

-- Down Migration

DROP TRIGGER outbox_account_from_parent ON outbox;
DROP TRIGGER event_account_from_parent ON event;
DROP TRIGGER input_request_account_from_parent ON input_request;
DROP TRIGGER session_account_from_parent ON session;
ALTER TABLE outbox ALTER COLUMN account_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE event ALTER COLUMN account_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE input_request ALTER COLUMN account_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE session ALTER COLUMN account_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
DROP FUNCTION conductor_account_from_parent();
