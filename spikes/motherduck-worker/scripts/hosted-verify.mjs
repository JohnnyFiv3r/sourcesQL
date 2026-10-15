// Secrets are inherited through environment, never argv or receipts.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const path = new URL("../../../local/motherduck-probe/settings.json",import.meta.url);
const settings = JSON.parse(readFileSync(path,"utf8"));
assert.equal(process.env.ALLOW_LIVE_PROBE,"true");
assert.ok(settings.preview_url && settings.gateway_token && settings.vercel_bypass,
  "Configure explicitly approved temporary test access before reserving a submission.");
assert.notEqual(settings.test_deployments_removed,true,
  "Provision a fresh preview before deliberate live verification.");
const kind=process.argv[2] ?? "tiny";
assert.ok(["tiny","dependencies"].includes(kind));
assert.ok((settings.submission_attempts ?? 0)<settings.max_flight_submissions);
settings.submission_attempts=(settings.submission_attempts ?? 0)+1;
writeFileSync(path,JSON.stringify(settings),{mode:0o600});
const result=spawnSync(process.execPath,[fileURLToPath(new URL("verify.mjs",import.meta.url))],{
  stdio:"inherit",env:{...process.env,PROBE_URL:settings.preview_url,
    GATEWAY_TOKEN:settings.gateway_token,VERCEL_AUTOMATION_BYPASS_SECRET:settings.vercel_bypass,
    PROBE_KIND:kind}});
process.exitCode=result.status ?? 1;
