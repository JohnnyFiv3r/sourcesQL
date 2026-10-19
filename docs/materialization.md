# Effective saved tables as engine inputs

Query, explain and explicit `sourcesql_materialize_research` share one materialization contract, `sourcesql.app-effective.v1`. Selection captures the root, amendment revision and complete related dependency closure from one app-state read. Only that closure is resolved and authorized. A filesystem writer lock or database transaction is never held across canonical resolution or a Flight.

The imported table preserves full row/column order, row IDs, declared types/nullability and exact effective values, including explicit null amendments. Existing primitive fallback inference applies only to undeclared columns. It does not serialize arbitrary objects or make unsupported Python representations valid. A private contributor anywhere in the captured closure makes the promotion private-derived. Provider disclosure still requires the existing grants.

Canonical engine parents are sorted unique `dataRef.resultId` values, with original/null pins. The app amendment revision belongs in provenance and in subsequent effective bindings. Descriptive origin IDs are not verified engine parents. Implicit selection requires a unique active canonical dataRef; inline successors remain supported by explicit materialization and subsequent original/null bindings. Imports retain input-set lineage and values-only replay; they do not create quotation evidence for edited values.

## Hosted preparation and replay

For a query or explain using effective inputs, provide the outer request UUID before materialization. The owner-scoped `input_preparations` record binds that UUID to:

- The operation and SHA-256 of the normalized original request, using the gateway's existing defaults and reviewed policy normalization.
- The recipe and a sorted alias manifest of selected snapshot, revision, normalized import-request hash and exact import job ID.

The complete import job set and binding commit in the same owner-serialized transaction. Captured table payloads remain in existing job records. Queue and retained operational byte bounds apply to the batch; a refusal rolls back its entire new set. An import may be shared by multiple aliases when its complete request is identical.

Identical pending requests reuse the saved jobs. Changed arguments, recipe, closure, values or classification conflict before replacement dispatch. A direct query cannot take a UUID reserved by a preparation. Fast downstream recovery also compares the captured manifest before dispatch. Each preparation pass advances every distinct import within existing Flight capacity, and its reservations share one transaction-local queue/byte account. Once the recorded imports complete, the downstream request uses their exact result mappings and the original outer UUID. A crash after downstream enqueue recovers that job without preparing inputs again. Unknown submission outcomes continue to hold their slot and are never replaced automatically.

Every MCP query/explain retry checks the current captured app closure and original input pins before a saved job may dispatch or return. Canonical engine metadata is authorized independently of app labels before full table resolution; an authorized private canonical contributor makes promotion private-derived even when its app label says public. Local saved rows pass the same output disclosure check as fresh output. All recorded engine dependencies are reauthorized before dispatch and completed-result reuse. A status lookup never starts work. Pending tool receipts distinguish import dependencies from downstream execution and retain the original-operation continuation instructions.

Local keyed query replay performs one identity lookup and uses Python's existing typed import normalization and authorized parent content hashes to compare the prospective request with the persisted request before imports. Compatible work reopens its existing result or exact run. Legacy or changed context receives an inspection-required conflict. Unkeyed local queries and synchronous local explain have no durable outer-request recovery promise. The case-folded request index preserves historical UUID spelling/ambiguity checks without a full runs-table scan. Query admission and replay share one unchanged profile fingerprint recipe.

## Upgrade procedure

1. Inventory exact pending import, query and explain handles in the intended owner namespace. Preserve each original request and its artifact identities. Do not alter grants, ledgers, metering mode or uncertain jobs to clear a deployment.
2. Settle legacy import-only preparations through their existing exact handles before cutover, or retain them for explicit inspection. There is no reliable automatic association from an orphan import to an outer UUID.
3. Deploy additive shared schema and source-matched gateway/worker artifacts together. New preparation records are outside exported app state and app-state history. Existing records remain immutable.
4. Existing outer UUIDs without a compatible preparation conflict before new imports. Inspect the recorded job/run/result. Do not silently mint a new request UUID, resubmit an uncertain Flight or infer an association from names or timestamps. Creating replacement work requires a deliberate new request after inspection.

Changing the import recipe can change result and job identities even when displayed values stay the same. The provenance marker describes the recipe; it does not migrate old identities or prove historical correctness.

## Historical audit and replacements

Use a bounded read-only owner inspection, not an automatic rewrite:

1. Page through old imported-result metadata, selecting legacy effective-view provenance and a single parent as candidate indicators. These are not proof of missing ancestry.
2. Match a candidate to retained app/export/history records for its exact historical root revision and dependency context. Record which contributing canonical sources are established by that evidence. If only today's closure is available, mark historical ancestry unverified.
3. For confirmed candidates, traverse authoritative `metadata.parents` to report recorded descendants. Preserve old records. Materialize a verifiable intended view with the new recipe and record old-to-new mappings; label a reconstruction from current state as a current replacement.
4. Any targeted revocation follows the owner's existing operating authority. Independent stores and previously exported bundles are not recalled automatically.

Restored bundles remap authoritative parents and result mappings. Descriptive inherited provenance can retain foreign IDs. Authorization follows the remapped parents; this change does not rewrite historical provenance.

## Qualification and remaining work

Boundary regressions cover coherent selection, full typed tables, private inline contributors, parent revocation and bundle restoration. Native local SQL fixtures cover preparation concurrency, lost acknowledgements, queue rollback, exact mappings and replay. These are separate from remote MotherDuck, real Flights, live providers and ChatGPT/Claude rendering.

The local workspace harness is `apps/research/scripts/measure-workspace.mts`; use an ignored output path. It measures existing current/history limits and reports the first legitimate refusal without changing allowances. Exact portable bundle retries retain authorization checks and add no duplicate app-state history. A broader data-model migration remains separately designed and reviewed; the current implementation retains its limits.

See [qualification scripts](../scripts/qualification.md) for explicit remote effects and reviewed execution plans. No source-only pass establishes deployed rendering or billed provider behavior.

Known inherited limitation: some DECIMAL inputs exceeding Python's default decimal context precision remain refused by existing type validation. This correction preserves wire values and refusals; it does not qualify a wider arithmetic range.
