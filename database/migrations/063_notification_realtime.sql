-- 063_notification_realtime.sql — live notification push (PLAN §26)
--
-- In-app notifications are written by more than one process: the API (mentions, service desk,
-- customer success, voice, processes) and the worker (workflows, BPM timers, activity reminders).
-- A PostgreSQL channel is therefore the fan-out point: every insert publishes a small event, and
-- each API process listening on the channel pushes it to the signed-in recipient's open stream.
-- The payload is intentionally tiny (recipient, id, type) so a delivery cannot approach the 8 kB
-- channel limit; the SPA re-reads the rows it is allowed to see instead of trusting the event body.

CREATE OR REPLACE FUNCTION notify_notification_insert() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'crm_notifications',
    json_build_object(
      'userId', NEW.user_id,
      'id', NEW.id,
      'type', NEW.type
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_publish ON notifications;
CREATE TRIGGER notifications_publish
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notify_notification_insert();
