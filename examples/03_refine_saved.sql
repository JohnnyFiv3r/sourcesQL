-- Bind input.previous to a committed authorized result; this makes no new search/model calls.
SELECT
  project,
  TRY_CAST(planned_mw AS BIGINT) AS planned_mw,
  grid_status,
  url
FROM input.previous
WHERE TRY_CAST(planned_mw AS BIGINT) >= 500
ORDER BY planned_mw DESC, project;
