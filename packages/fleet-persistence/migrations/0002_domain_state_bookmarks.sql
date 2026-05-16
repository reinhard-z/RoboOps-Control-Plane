CREATE TABLE IF NOT EXISTS fleet_persistence.domain_state_bookmarks (
  state_id text PRIMARY KEY,
  processed_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  processed_ack_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  processed_reconnect_session_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  next_sequence_by_robot jsonb NOT NULL DEFAULT '{}'::jsonb,
  domain_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  audit_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_state_bookmarks_singleton CHECK (state_id = 'current')
);

COMMENT ON TABLE fleet_persistence.domain_state_bookmarks IS
  'Singleton reducer bookkeeping for the current DomainState repository view.';
