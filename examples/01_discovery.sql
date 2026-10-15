-- Proposed sourcesQL v0.1. Uses deliberately fictional fixtures in fixture mode.
SELECT
  url,
  SEM_EXTRACT(content, 'project name explicitly stated') AS project,
  SEM_EXTRACT(content, 'planned capacity in MW, number only') AS planned_mw,
  SEM_EXTRACT(content, 'operating capacity in MW, number only') AS operating_mw,
  SEM_EXTRACT(content, 'grid agreement status explicitly stated') AS grid_status
FROM WEB_SEARCH(
  'fictional data center campuses capacity grid status',
  'fictional Aurora Birch project planning'
)
WHERE SEM_MATCH(content, 'describes a specific data-center campus');
