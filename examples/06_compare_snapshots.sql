-- A value diff proposes investigation. It does not establish a factual change.
SELECT
  old.entity_key,
  old.grid_status AS prior_observation,
  newer.grid_status AS newer_observation
FROM input.old_snapshot old
INNER JOIN input.new_snapshot newer
  ON old.entity_key = newer.entity_key
WHERE old.grid_status IS DISTINCT FROM newer.grid_status;
