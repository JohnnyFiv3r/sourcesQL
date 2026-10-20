"""Versioned coordinator contracts, independent of the distribution version."""

CURATED_CITATION_CONTRACT = "sourcesql.curated-citation.v1"
MATERIALIZATION_CONTRACT = "sourcesql.app-effective.v2"
RESULT_INSPECTION_CONTRACT = "sourcesql.result-inspection.v1"
CELL_ORIGINS_ENCODING = "indexed-cells.v1"

WORKER_FEATURE_CONTRACTS = {
    "curated_citations": CURATED_CITATION_CONTRACT,
    "materialized_cell_origins": MATERIALIZATION_CONTRACT,
    "cell_origins_encoding": CELL_ORIGINS_ENCODING,
    "result_inspection": RESULT_INSPECTION_CONTRACT,
}
