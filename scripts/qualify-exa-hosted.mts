/** One explicitly approved search-only Flight; later invocations only inspect it.
 * Operator files and receipts must stay in ignored local/ and artifacts/ paths.
 */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MotherDuckEngine} from '../apps/research/server/motherduck.js';
const [setupPath,receiptPath,action='inspect']=process.argv.slice(2);
if(!setupPath||!receiptPath||!['submit','inspect'].includes(action))throw Error('Use SETUP_JSON RECEIPT_JSON [submit|inspect]');
const setup=JSON.parse(readFileSync(setupPath,'utf8'));
if(!setup.provider_policy || setup.provider_policy.approved_cost_microusd>50000
  || setup.provider_daily_cost_microusd>1000000)throw Error('A bounded explicit Exa setup is required');
const path=resolve(receiptPath);
let receipt:any=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
if(receipt&&(receipt.flight_id!==setup.flight_id||receipt.database!==setup.database))throw Error('Receipt belongs to another setup');
if(!receipt&&action!=='submit')throw Error('No prior qualification submission to inspect');
receipt??={schema:'sourcesql.hosted-exa-qualification.v1',database:setup.database,flight_id:setup.flight_id,
  request_id:randomUUID(),created_at:new Date().toISOString(),wheel_sha256:setup.wheel_sha256,
  source_sha256:setup.flight_source_sha256,requirements_sha256:setup.requirements_sha256,
  provider_policy_sha256:setup.provider_policy_sha256,auto_retries:0};
mkdirSync(dirname(path),{recursive:true});
const save=()=>writeFileSync(path,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
save();
const token=process.env.MOTHERDUCK_TOKEN??JSON.parse(readFileSync(`${homedir()}/.motherduck/credentials.json`,'utf8')).motherduck_token;
// The owner's CLI identity is a public stable namespace, never a credential.
const principal=process.env.SOURCESQL_PRINCIPAL;
if(!principal)throw Error('Set the same SOURCESQL_PRINCIPAL used by hosted/setup.mjs');
const engine=new MotherDuckEngine({database:setup.database,host:setup.host,token,flightId:setup.flight_id,principal,
  allowSubmission:true,maxRuntimeSeconds:120,dailySeconds:600,sourceSha256:setup.flight_source_sha256,
  requirementsSha256:setup.requirements_sha256,exa:{approvedCostMicrousd:setup.provider_policy.approved_cost_microusd,
    dailyCostMicrousd:setup.provider_daily_cost_microusd,secretName:setup.provider_policy.secret_name}});
try {
  await engine.initialize();
  if(action==='submit') {
    const submission=await engine.enqueue({request_id:receipt.request_id,profile:'exa',source_mode:'allow_excerpt',
      query:"SELECT url,title,content FROM WEB_SEARCH('MotherDuck Flights documentation', per_query_limit := 3)",
      budgets:{max_search_queries:1,max_search_requests:1,max_candidates:3,max_fetches:0,max_semantic_documents:0,
        max_model_requests:0,max_concurrency:1,dispatch_deadline_seconds:60,max_output_rows:3,
        max_output_bytes:1048576,max_input_tokens:0,max_output_tokens:0,max_cost_microusd:50000}});
    receipt.submission=submission;save();
  }
  if(!receipt.submission?.job_id) {
    const saved=await engine.connection(async client=>(await client.query(`SELECT CAST(id AS VARCHAR) AS id FROM ${engine.table('jobs')} WHERE request_id=$1::UUID`,[receipt.request_id])).rows[0]);
    if(saved)receipt.submission={job_id:saved.id};
  }
  const id=receipt.submission?.job_id;
  if(!id)throw Error('Submission not found; inspect before starting any new request');
  receipt.job=await engine.jobStatus(id);save();
  if(receipt.job.result_id) {
    const result:any=await engine.call('read_result',{result_id:receipt.job.result_id});
    receipt.result=result;
    const counts=result.receipt?.counts??{};
    if(counts.search_requests!==1||Number(counts.fetches??0)!==0||Number(counts.model_requests??0)!==0
      ||result.rows.length>3||result.receipt?.status!=='completed')throw Error('Unexpected live qualification execution');
    receipt.checks={one_search:true,no_fetch_or_model_calls:true,result_retained:true,row_count:result.rows.length,
    content_basis:[...new Set((result.source_versions??[]).map((source:any)=>source.content_basis))],
      provider_events:result.receipt?.provider_events??[]};
  }
  const stored=await engine.connection(async client=>(await client.query(`SELECT CAST(flight_run_number AS VARCHAR) AS n,
    provider_cost_reserved_microusd FROM ${engine.table('jobs')} WHERE id=$1::UUID`,[id])).rows[0]);
  receipt.reserved_microusd=String(stored.provider_cost_reserved_microusd);
  if(stored.n&&/^[1-9][0-9]{0,19}$/.test(stored.n)) {
    const run=await engine.connection(async client=>(await client.query(`SELECT status,exit_code,
      epoch(ended_at-started_at) AS elapsed_seconds FROM md_get_flight_run(flight_id := '${setup.flight_id}'::UUID,run_number := ${stored.n}::UBIGINT)`)).rows[0]);
    receipt.platform_run=run;
    if(['SUCCEEDED','FAILED','CANCELLED'].includes(String(run?.status).replace(/^RUN_STATUS_/,''))) {
      const logs=await engine.connection(async client=>(await client.query(`SELECT * FROM md_get_flight_logs(flight_id := '${setup.flight_id}'::UUID,run_number := ${stored.n}::UBIGINT,"LIMIT" := 100)`)).rows);
      for(const row of logs)for(const value of Object.values(row)) {
        if(typeof value==='string'&&value.startsWith('{"schema": "sourcesql.hosted-flight-run.v1"')) {
          const report=JSON.parse(value.trim());if(report.job_id===id)receipt.flight_report=report;
        }
      }
    }
  }
  receipt.inspected_at=new Date().toISOString();save();
  console.log(JSON.stringify({job:receipt.job,checks:receipt.checks,platform_run:receipt.platform_run,
    reserved_microusd:receipt.reserved_microusd,receipt:path}));
} catch(error:any) {
  receipt.last_failure={code:error.code??error.name,at:new Date().toISOString()};save();
  console.error(JSON.stringify({failed:true,code:error.code??error.name,inspect_same_request_id:receipt.request_id,receipt:path}));
  process.exitCode=1;
}
