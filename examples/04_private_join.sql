-- Bind both aliases locally. The result is private-derived. No external functions are invoked.
SELECT
  p.private_entity_id,
  p.entity_key,
  p.expert_capacity_mw,
  w.planned_mw AS public_planned_mw,
  w.url
FROM input.private_entities p
LEFT JOIN input.public_observations w
  ON p.entity_key = w.entity_key;
