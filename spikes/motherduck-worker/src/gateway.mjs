// Probe only: fixed synthetic Flight and tables, one operator-configured principal.
// No Python process, HTTP bridge, arbitrary SQL or automatic dispatch retry.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hosts = new Set(["pg.us-east-1-aws.motherduck.com", "pg.eu-central-1-aws.motherduck.com"]);
const runColumns = `CAST(run_id AS VARCHAR) AS run_id,
  CAST(flight_id AS VARCHAR) AS flight_id, flight_version,
  CAST(run_number AS VARCHAR) AS run_number, status, exit_code,
  CAST(config AS JSON)::VARCHAR AS config_json,
  CAST(created_at AS VARCHAR) AS created_at,
  CAST(started_at AS VARCHAR) AS started_at,
  CAST(ended_at AS VARCHAR) AS ended_at`;

function response(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function requireUuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new InputError();
  return value.toLowerCase();
}
function runNumber(value) {
  // UBIGINT stays a decimal string, including beyond JS's safe integer range.
  if (!/^[1-9][0-9]{0,19}$/.test(value ?? "") || BigInt(value) > 18446744073709551615n) {
    throw new InputError();
  }
  return value;
}
class InputError extends Error {}
function selectedFlight(env, kind = "tiny") {
  if (!["tiny", "dependencies"].includes(kind)) throw new InputError();
  return requireUuid(kind === "dependencies" ? env.DEPENDENCY_FLIGHT_ID : env.FLIGHT_ID);
}
function decodeRun(row) {
  const { config_json, ...run } = row;
  return { ...run, config: JSON.parse(config_json) };
}

export function makeGateway(createClient, definitions = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return response({ mode: "synthetic-integration-probe", live_qualified: false });
      }
      if (!env.GATEWAY_TOKEN || request.headers.get("authorization") !== `Bearer ${env.GATEWAY_TOKEN}`) {
        return response({ error: "unauthorized" }, 401);
      }
      if (!hosts.has(env.MOTHERDUCK_HOST) || !env.MOTHERDUCK_DB || !env.MOTHERDUCK_TOKEN) {
        return response({ error: "missing_or_invalid_configuration" }, 503);
      }
      let client;
      let dispatchAttempted = false;
      try {
        let operation;
        if (url.pathname === "/connection" && request.method === "GET") {
          operation = async (c) => ({ rows: (await c.query("SELECT CAST(1 AS INTEGER) AS ok")).rows });
        } else if (url.pathname === "/flight/create" && request.method === "POST") {
          if (env.ALLOW_FLIGHT_PROVISIONING !== "true") return response({ error: "provisioning_disabled" }, 403);
          const body = await request.json();
          const definition = definitions[body.kind];
          if (!definition || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(env.MOTHERDUCK_DB)) throw new InputError();
          const literal = (value) => `'${value.replaceAll("'", "''")}'`;
          operation = async (c) => {
            const created = await c.query(`SELECT CAST(flight_id AS VARCHAR) AS flight_id,
              flight_name, current_version FROM md_create_flight(
                name := ${literal(definition.name)}, source_code := ${literal(definition.source)},
                requirements_txt := ${literal(definition.requirements)},
                config := MAP {'REQUEST_ID': 'unsubmitted', 'DATABASE': ${literal(env.MOTHERDUCK_DB)}},
                instance_type := 'F4', max_runtime_sec := 120)`);
            return { flights: created.rows, kind: body.kind, instance_type: "F4", max_runtime_sec: 120, scheduled: false };
          };
        } else if (url.pathname === "/flight/submit" && request.method === "POST") {
          if (env.ALLOW_FLIGHT_SUBMISSION !== "true") return response({ error: "submission_disabled" }, 403);
          const body = await request.json();
          const flight = selectedFlight(env, body.kind);
          const requestId = requireUuid(body.request_id);
          operation = async (c) => {
            dispatchAttempted = true;
            // Flight control functions require literals. Only validated UUIDs and
            // bounded unsigned integers are interpolated; ordinary data is bound.
            const result = await c.query(`SELECT ${runColumns} FROM md_run_flight(
              flight_id := '${flight}'::UUID,
              config := MAP {'REQUEST_ID': '${requestId}'})`);
            if (result.rows.length !== 1) throw new Error("Unexpected run count");
            const run = decodeRun(result.rows[0]);
            if (run.config.REQUEST_ID !== requestId || run.flight_id !== flight) throw new Error("Uncorrelated dispatch");
            requireUuid(run.run_id);
            runNumber(run.run_number);
            // Controlled fault injection: the run exists, but no handle reaches
            // the caller. Recovery must inspect history, never repeat dispatch.
            if (body.simulate_lost_response === true) throw new Error("Simulated lost response");
            return { request_id: requestId, run };
          };
        } else if (["/flight/run", "/flight/runs", "/flight/logs", "/flight/recover"].includes(url.pathname) && request.method === "GET") {
          const flight = selectedFlight(env, url.searchParams.get("kind") ?? "tiny");
          const recoverId = url.pathname === "/flight/recover" ? requireUuid(url.searchParams.get("request_id")) : undefined;
          const number = ["/flight/runs", "/flight/recover"].includes(url.pathname) ? undefined : runNumber(url.searchParams.get("run_number"));
          operation = async (c) => {
            if (url.pathname === "/flight/logs") {
              // Logs remain protected. The verifier does not print their contents.
              return { rows: (await c.query(`SELECT * FROM md_get_flight_logs(
                flight_id := '${flight}'::UUID, run_number := ${number}::UBIGINT,
                "LIMIT" := 20, "ORDER" := 'desc')`)).rows };
            }
            const functionCall = number
              ? `md_get_flight_run(flight_id := '${flight}'::UUID, run_number := ${number}::UBIGINT)`
              : `md_list_flight_runs(flight_id := '${flight}'::UUID, "LIMIT" := 20)`;
            const runs = (await c.query(`SELECT ${runColumns} FROM ${functionCall}`)).rows.map(decodeRun);
            if (!recoverId) return { runs };
            const matched = runs.filter((run) => run.config.REQUEST_ID === recoverId);
            return { request_id: recoverId, runs: matched,
              recovery: matched.length === 1 ? "found" : matched.length > 1 ? "duplicate_runs" : "not_found_in_latest_20",
              safe_to_resubmit: false };
          };
        } else if (url.pathname === "/results" && request.method === "GET") {
          const requestId = requireUuid(url.searchParams.get("request_id"));
          operation = async (c) => {
            const jobs = await c.query(`SELECT columns_json FROM sourcesql_gateway_probe_jobs
              WHERE request_id = $1::UUID`, [requestId]);
            if (!jobs.rows.length) return { pending: true, rows: [] };
            const rows = await c.query(`SELECT row_id, payload_json FROM sourcesql_gateway_probe_rows
              WHERE request_id = $1::UUID ORDER BY row_id`, [requestId]);
            const corrections = await c.query(`SELECT CAST(revision_id AS VARCHAR) AS revision_id,
              row_id, column_name, value, CAST(created_at AS VARCHAR) AS created_at
              FROM sourcesql_gateway_probe_corrections WHERE request_id = $1::UUID
              ORDER BY created_at, revision_id`, [requestId]);
            return { request_id: requestId, columns: JSON.parse(jobs.rows[0].columns_json),
              rows: rows.rows.map(({ row_id, payload_json }) => ({ row_id, values: JSON.parse(payload_json) })),
              corrections: corrections.rows };
          };
        } else if (url.pathname === "/tree" && request.method === "GET") {
          operation = async (c) => ({ nodes: (await c.query(`SELECT CAST(request_id AS VARCHAR) AS request_id,
            title, CAST(created_at AS VARCHAR) AS created_at FROM sourcesql_gateway_probe_jobs
            ORDER BY created_at DESC LIMIT 20`)).rows });
        } else if (url.pathname === "/corrections" && request.method === "POST") {
          const body = await request.json();
          const requestId = requireUuid(body.request_id);
          const revisionId = requireUuid(body.revision_id);
          if (body.row_id !== "fictional-a" || typeof body.value !== "number" || !Number.isFinite(body.value)) {
            throw new InputError();
          }
          operation = async (c) => {
            // Append a historical application row; never overwrite original data.
            const amended = await c.query(`INSERT INTO sourcesql_gateway_probe_corrections
              (revision_id, request_id, row_id, column_name, value)
              SELECT $1::UUID, $2::UUID, $3::VARCHAR, 'planned_mw', $4::DOUBLE
              WHERE EXISTS (SELECT 1 FROM sourcesql_gateway_probe_rows
                WHERE request_id = $2::UUID AND row_id = $3::VARCHAR)
              RETURNING CAST(revision_id AS VARCHAR) AS revision_id`,
              [revisionId, requestId, body.row_id, body.value]);
            if (amended.rows.length !== 1) return { error: "correction_target_missing", accepted: false };
            return { revision_id: revisionId, request_id: requestId };
          };
        } else {
          return response({ error: "unknown_route_or_method" }, 404);
        }
        client = createClient(env);
        await client.connect();
        return response(await operation(client));
      } catch (error) {
        if (error instanceof InputError || error instanceof SyntaxError && !client) {
          return response({ error: "invalid_input" }, 400);
        }
        // Do not expose connection strings, provider logs or database error text.
        // A lost submit response does not establish that no remote run was created.
        const databaseCode = /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? error.code : undefined;
        return response({ error: dispatchAttempted ? "dispatch_outcome_unknown" : "gateway_operation_failed",
          automatic_retry: false, ...(databaseCode ? { database_code: databaseCode } : {}) }, 502);
      } finally {
        if (client) await client.end().catch(() => {});
      }
    },
  };
}
