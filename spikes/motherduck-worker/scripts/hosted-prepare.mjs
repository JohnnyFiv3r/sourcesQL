// Explicit operator provisioning; no Flight is run by this script.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";

const settingsPath = new URL("../../../local/motherduck-probe/settings.json", import.meta.url);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
assert.equal(process.env.ALLOW_LIVE_PROBE, "true");
assert.ok(settings.preview_url && settings.gateway_token && settings.vercel_bypass);
assert.equal(new URL(settings.preview_url).protocol, "https:");
const headers = {authorization:`Bearer ${settings.gateway_token}`,
  "content-type":"application/json", "x-vercel-protection-bypass":settings.vercel_bypass};
async function call(path, body) {
  const res = await fetch(new URL(path, settings.preview_url), {headers,
    method:body ? "POST" : "GET", body:body ? JSON.stringify(body) : undefined,
    redirect:"error", signal:AbortSignal.timeout(25000)});
  const data = await res.json();
  assert.equal(res.status,200,`${path}: ${data.error ?? res.status}`);
  return data;
}
assert.equal((await call("/connection")).rows[0].ok,1);
console.log(JSON.stringify({hosted_postgres_connection:"passed"}));
for (const kind of ["tiny","dependencies"]) {
  // Save each known ID immediately. An ambiguous create is never repeated here.
  if (settings.flight_ids?.[kind]) continue;
  const data = await call("/flight/create",{kind});
  assert.equal(data.instance_type,"F4");
  assert.equal(data.max_runtime_sec,120);
  assert.equal(data.scheduled,false);
  assert.equal(data.flights.length,1);
  const flight = data.flights[0];
  assert.match(flight.flight_id,/^[0-9a-f-]{36}$/i);
  settings.flight_ids = {...settings.flight_ids,[kind]:flight.flight_id};
  writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});
  console.log(JSON.stringify({hosted_flight_created:kind,flight_id:flight.flight_id,instance_type:"F4",max_runtime_sec:120}));
}
