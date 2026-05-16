CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS fleet_persistence;

CREATE TABLE IF NOT EXISTS fleet_persistence.schema_migrations (
  migration_name text PRIMARY KEY,
  checksum_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fleet_persistence.schema_migrations IS
  'Applied fleet-persistence SQL migrations and their immutable checksums.';

CREATE TABLE IF NOT EXISTS fleet_persistence.robots (
  robot_id text PRIMARY KEY,
  connection_state text NOT NULL,
  health text,
  battery_percent integer,
  active_mission_id text,
  last_telemetry_observed_at timestamptz,
  last_telemetry_received_at timestamptz,
  last_acknowledged_command_id text,
  last_seen_command_sequence bigint NOT NULL DEFAULT 0,
  edge_agent_version text,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  CONSTRAINT robots_battery_percent_range CHECK (
    battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT robots_last_seen_command_sequence_nonnegative CHECK (
    last_seen_command_sequence >= 0
  )
);

COMMENT ON TABLE fleet_persistence.robots IS
  'Latest durable robot snapshot used to rebuild DomainState.';

CREATE TABLE IF NOT EXISTS fleet_persistence.robot_sessions (
  robot_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id text NOT NULL REFERENCES fleet_persistence.robots (robot_id),
  edge_session_id text NOT NULL,
  connected_at timestamptz NOT NULL,
  disconnected_at timestamptz,
  last_seen_command_sequence bigint NOT NULL DEFAULT 0,
  last_acknowledged_command_id text,
  edge_agent_version text,
  hello_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT robot_sessions_robot_edge_session_key UNIQUE (
    robot_id,
    edge_session_id
  ),
  CONSTRAINT robot_sessions_sequence_nonnegative CHECK (
    last_seen_command_sequence >= 0
  )
);

COMMENT ON TABLE fleet_persistence.robot_sessions IS
  'Edge connection sessions observed by the platform gateway.';

CREATE TABLE IF NOT EXISTS fleet_persistence.missions (
  mission_id text PRIMARY KEY,
  robot_id text NOT NULL REFERENCES fleet_persistence.robots (robot_id),
  lifecycle_state text NOT NULL,
  operational_status text NOT NULL,
  current_command_id text,
  last_command_sequence bigint,
  last_acknowledged_command_id text,
  last_acknowledged_command_sequence bigint,
  idempotency_key text,
  failure_reason text,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT missions_last_command_sequence_nonnegative CHECK (
    last_command_sequence IS NULL OR last_command_sequence >= 0
  ),
  CONSTRAINT missions_last_acknowledged_command_sequence_nonnegative CHECK (
    last_acknowledged_command_sequence IS NULL
      OR last_acknowledged_command_sequence >= 0
  )
);

COMMENT ON TABLE fleet_persistence.missions IS
  'Latest durable mission snapshot plus lifecycle metadata.';

CREATE TABLE IF NOT EXISTS fleet_persistence.commands (
  command_row_id bigserial PRIMARY KEY,
  command_id text NOT NULL,
  mission_id text NOT NULL REFERENCES fleet_persistence.missions (mission_id),
  robot_id text NOT NULL REFERENCES fleet_persistence.robots (robot_id),
  type text NOT NULL,
  idempotency_key text NOT NULL,
  sequence bigint NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  requires_ack boolean NOT NULL,
  safety_class text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text NOT NULL,
  payload_json jsonb NOT NULL,
  envelope_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commands_command_id_key UNIQUE (command_id),
  CONSTRAINT commands_robot_id_sequence_key UNIQUE (robot_id, sequence),
  CONSTRAINT commands_sequence_positive CHECK (sequence > 0)
);

COMMENT ON TABLE fleet_persistence.commands IS
  'Durable command log with robot-local sequence protection.';

CREATE TABLE IF NOT EXISTS fleet_persistence.command_acks (
  ack_id text PRIMARY KEY,
  command_id text NOT NULL,
  mission_id text,
  robot_id text NOT NULL,
  resolved_command_id text REFERENCES fleet_persistence.commands (command_id),
  resolved_mission_id text REFERENCES fleet_persistence.missions (mission_id),
  status text NOT NULL,
  received_at timestamptz NOT NULL,
  last_seen_command_sequence bigint NOT NULL,
  reason text,
  correlation_id text NOT NULL,
  causation_id text NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT command_acks_sequence_nonnegative CHECK (
    last_seen_command_sequence >= 0
  )
);

COMMENT ON TABLE fleet_persistence.command_acks IS
  'Edge acknowledgements for commands received over the gateway.';

CREATE TABLE IF NOT EXISTS fleet_persistence.domain_events (
  event_row_id bigserial PRIMARY KEY,
  event_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  mission_id text,
  robot_id text,
  command_id text,
  correlation_id text NOT NULL,
  causation_id text,
  payload_json jsonb NOT NULL,
  envelope_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_events_event_id_key UNIQUE (event_id)
);

COMMENT ON TABLE fleet_persistence.domain_events IS
  'Reducer-produced domain events persisted before outbox publication.';

CREATE TABLE IF NOT EXISTS fleet_persistence.robot_telemetry_events (
  telemetry_row_id bigserial PRIMARY KEY,
  event_id text NOT NULL,
  robot_id text NOT NULL,
  resolved_robot_id text REFERENCES fleet_persistence.robots (robot_id),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  pose_json jsonb NOT NULL,
  battery_percent integer NOT NULL,
  health text NOT NULL,
  connection_state text NOT NULL,
  current_mission_id text,
  resolved_mission_id text REFERENCES fleet_persistence.missions (mission_id),
  last_acknowledged_command_id text,
  last_seen_command_sequence bigint NOT NULL,
  edge_agent_version text NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT robot_telemetry_events_event_id_key UNIQUE (event_id),
  CONSTRAINT robot_telemetry_events_battery_percent_range CHECK (
    battery_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT robot_telemetry_events_sequence_nonnegative CHECK (
    last_seen_command_sequence >= 0
  )
);

COMMENT ON TABLE fleet_persistence.robot_telemetry_events IS
  'Immutable robot telemetry event log accepted from edge runtimes.';

CREATE TABLE IF NOT EXISTS fleet_persistence.audit_events (
  audit_event_id text PRIMARY KEY,
  actor_type text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  mission_id text,
  robot_id text,
  command_id text,
  correlation_id text NOT NULL,
  causation_id text,
  details_json jsonb NOT NULL,
  envelope_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fleet_persistence.audit_events IS
  'Human-facing durable audit trail for domain and operator decisions.';

CREATE TABLE IF NOT EXISTS fleet_persistence.outbox_events (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  last_error text,
  dedupe_key text,
  CONSTRAINT outbox_events_attempt_count_nonnegative CHECK (attempt_count >= 0)
);

COMMENT ON TABLE fleet_persistence.outbox_events IS
  'Transactional outbox queue for future at-least-once publication workers.';

CREATE TABLE IF NOT EXISTS fleet_persistence.idempotency_keys (
  idempotency_key_id bigserial PRIMARY KEY,
  "key" text NOT NULL,
  payload_signature text NOT NULL,
  mission_id text REFERENCES fleet_persistence.missions (mission_id),
  command_id text REFERENCES fleet_persistence.commands (command_id),
  response_json jsonb,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT idempotency_keys_key_key UNIQUE ("key")
);

COMMENT ON TABLE fleet_persistence.idempotency_keys IS
  'Durable idempotency records for operator/API command requests.';

CREATE INDEX IF NOT EXISTS robot_sessions_robot_id_connected_at_idx
  ON fleet_persistence.robot_sessions (robot_id, connected_at DESC);

CREATE INDEX IF NOT EXISTS missions_robot_id_lifecycle_state_idx
  ON fleet_persistence.missions (robot_id, lifecycle_state);

CREATE INDEX IF NOT EXISTS commands_mission_id_idx
  ON fleet_persistence.commands (mission_id);

CREATE INDEX IF NOT EXISTS command_acks_command_id_received_at_idx
  ON fleet_persistence.command_acks (command_id, received_at DESC);

CREATE INDEX IF NOT EXISTS command_acks_robot_id_received_at_idx
  ON fleet_persistence.command_acks (robot_id, received_at DESC);

CREATE INDEX IF NOT EXISTS command_acks_resolved_command_id_idx
  ON fleet_persistence.command_acks (resolved_command_id);

CREATE INDEX IF NOT EXISTS domain_events_mission_id_received_at_idx
  ON fleet_persistence.domain_events (mission_id, received_at);

CREATE INDEX IF NOT EXISTS domain_events_robot_id_received_at_idx
  ON fleet_persistence.domain_events (robot_id, received_at);

CREATE INDEX IF NOT EXISTS domain_events_aggregate_received_at_idx
  ON fleet_persistence.domain_events (aggregate_type, aggregate_id, received_at);

CREATE INDEX IF NOT EXISTS robot_telemetry_events_robot_id_received_at_idx
  ON fleet_persistence.robot_telemetry_events (robot_id, received_at DESC);

CREATE INDEX IF NOT EXISTS robot_telemetry_events_resolved_robot_id_idx
  ON fleet_persistence.robot_telemetry_events (resolved_robot_id);

CREATE INDEX IF NOT EXISTS audit_events_mission_id_occurred_at_idx
  ON fleet_persistence.audit_events (mission_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_robot_id_occurred_at_idx
  ON fleet_persistence.audit_events (robot_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS outbox_events_available_idx
  ON fleet_persistence.outbox_events (available_at, created_at)
  WHERE published_at IS NULL AND locked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_dedupe_key_key
  ON fleet_persistence.outbox_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
