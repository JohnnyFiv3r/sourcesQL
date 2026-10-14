-- v0.1 supported projected row-dependent source expression, then UNNEST.
-- Host resolves the exact selected row; input.selected contains that authorized row only.
SELECT
  project,
  UNNEST(
    WEB_SEARCH(project || ' grid agreement current status'),
    recursive := true
  )
FROM input.selected;
