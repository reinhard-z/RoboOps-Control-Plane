ALTER TABLE fleet_persistence.robot_sessions
  ADD COLUMN IF NOT EXISTS resolved_robot_id text;

UPDATE fleet_persistence.robot_sessions
SET resolved_robot_id = robot_id
WHERE resolved_robot_id IS NULL;

ALTER TABLE fleet_persistence.robot_sessions
  DROP CONSTRAINT IF EXISTS robot_sessions_robot_id_fkey;

DO $roboops_robot_session_resolution$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'robot_sessions_resolved_robot_id_fkey'
      AND conrelid = 'fleet_persistence.robot_sessions'::regclass
  ) THEN
    ALTER TABLE fleet_persistence.robot_sessions
      ADD CONSTRAINT robot_sessions_resolved_robot_id_fkey
      FOREIGN KEY (resolved_robot_id)
      REFERENCES fleet_persistence.robots (robot_id);
  END IF;
END
$roboops_robot_session_resolution$;

COMMENT ON COLUMN fleet_persistence.robot_sessions.robot_id IS
  'Raw robot identifier reported for the edge session.';

COMMENT ON COLUMN fleet_persistence.robot_sessions.resolved_robot_id IS
  'Nullable canonical robot reference resolved from the raw session robot id.';

CREATE INDEX IF NOT EXISTS robot_sessions_resolved_robot_id_idx
  ON fleet_persistence.robot_sessions (resolved_robot_id);
