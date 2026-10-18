// Generated from sourcesql.storage.motherduck; additive migrations preserve retained records.
export const tableDefinitions = [
  "CREATE TABLE IF NOT EXISTS input_preparations(request_id UUID PRIMARY KEY, operation VARCHAR NOT NULL, original_hash VARCHAR NOT NULL, recipe VARCHAR NOT NULL, manifest_json VARCHAR NOT NULL, created_at VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS usage_notice_dismissals(id VARCHAR PRIMARY KEY,dismissed_at VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS usage_flights(run_id VARCHAR PRIMARY KEY,job_id UUID NOT NULL,started_at VARCHAR NOT NULL,ended_at VARCHAR NOT NULL,elapsed_seconds DOUBLE NOT NULL,instance_type VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY, namespace VARCHAR NOT NULL, revision BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS results(id VARCHAR PRIMARY KEY, hash VARCHAR NOT NULL, metadata VARCHAR NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, payload VARCHAR NOT NULL, wire_payload VARCHAR NOT NULL, wire_hash VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS runs(id VARCHAR PRIMARY KEY, request_id VARCHAR UNIQUE NOT NULL, request_hash VARCHAR NOT NULL, receipt VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS semantic_cache(key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS execution_stages(journal_id VARCHAR NOT NULL, stage_key VARCHAR NOT NULL, status VARCHAR NOT NULL, value_json VARCHAR, error_code VARCHAR, PRIMARY KEY(journal_id,stage_key))",
  "CREATE TABLE IF NOT EXISTS execution_journals(journal_id VARCHAR PRIMARY KEY,head_run_id VARCHAR NOT NULL,closed INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS execution_stage_usage(id INTEGER PRIMARY KEY,retained_bytes BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jobs(id UUID PRIMARY KEY, request_id UUID UNIQUE NOT NULL, operation VARCHAR NOT NULL, request_hash VARCHAR NOT NULL, request_json VARCHAR NOT NULL, status VARCHAR NOT NULL, created_at VARCHAR NOT NULL, updated_at VARCHAR NOT NULL, flight_id UUID NOT NULL, flight_version INTEGER, flight_run_id UUID, flight_run_number UBIGINT, dispatch_intent_at VARCHAR, claim_token UUID, engine_run_id VARCHAR, result_id VARCHAR, cancel_requested BOOLEAN NOT NULL DEFAULT false, error_code VARCHAR, error_message VARCHAR, max_runtime_sec INTEGER NOT NULL, output_json VARCHAR, flight_settled BOOLEAN NOT NULL DEFAULT false, flight_invalid BOOLEAN NOT NULL DEFAULT false, provider_policy_sha256 VARCHAR, provider_cost_reserved_microusd BIGINT NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS flight_allowances(day VARCHAR PRIMARY KEY, reserved_seconds BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS provider_allowances(day VARCHAR PRIMARY KEY, reserved_microusd BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY, revision BIGINT NOT NULL, state_json VARCHAR NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_state_history(revision BIGINT PRIMARY KEY, state_json VARCHAR NOT NULL, created_at VARCHAR NOT NULL)",
] as const;
export const tableMigrations = [
  "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS provider_policy_sha256 VARCHAR",
  "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS provider_cost_reserved_microusd BIGINT DEFAULT 0",
] as const;
