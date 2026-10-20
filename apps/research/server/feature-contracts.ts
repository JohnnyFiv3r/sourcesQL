/** Keep parity with sourcesql.feature_contracts; enforced by the contract test. */
export const CURATED_CITATION_CONTRACT = "sourcesql.curated-citation.v1";
export const MATERIALIZATION_CONTRACT = "sourcesql.app-effective.v2";
export const RESULT_INSPECTION_CONTRACT = "sourcesql.result-inspection.v1";
export const CELL_ORIGINS_ENCODING = "indexed-cells.v1";
export const WORKER_FEATURE_CONTRACTS = {
  curated_citations: CURATED_CITATION_CONTRACT,
  materialized_cell_origins: MATERIALIZATION_CONTRACT,
  cell_origins_encoding: CELL_ORIGINS_ENCODING,
  result_inspection: RESULT_INSPECTION_CONTRACT,
} as const;
