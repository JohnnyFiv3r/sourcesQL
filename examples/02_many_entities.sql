SELECT
  url,
  UNNEST(
    SEM_EXTRACT_ALL(
      content,
      'a specifically named campus',
      project := 'campus name',
      planned_mw := 'planned capacity in MW, number only',
      evidence := 'per_field'
    ),
    recursive := true
  )
FROM WEB_FETCH('https://aurora.example/project');
