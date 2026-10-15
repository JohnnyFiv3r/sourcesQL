/** Operator qualification against one explicitly provisioned, synthetic-only account.
 * Run actions sequentially: they share one local evidence receipt.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MotherDuckEngine, MotherDuckStateBackend, type SqlClient } from '../apps/research/server/motherduck.js';
const require = createRequire(new URL('../apps/research/package.json', import.meta.url));
const { Client } = require('pg');
const setup = JSON.parse(readFileSync('local/motherduck/hosted-setup.json', 'utf8'));
const directory = resolve('artifacts/hosted-storage-20261014');
mkdirSync(directory, {recursive:true});
const path = resolve(directory, 'receipt.json');
let receipt: any;
try { receipt = JSON.parse(readFileSync(path, 'utf8')); } catch (error: any) { if(error.code !== 'ENOENT') throw error; }
receipt ??= {schema:'sourcesql.hosted-storage-qualification.v1', database:setup.database, flight_id:setup.flight_id,
  wheel_sha256:setup.wheel_sha256, source_sha256:setup.flight_source_sha256, requirements_sha256:setup.requirements_sha256,
  provider_calls:0, auto_retries:0, jobs:{}, checks:{}, created_at:new Date().toISOString()};
const save = () => writeFileSync(path, JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
const token = JSON.parse(readFileSync(`${homedir()}/.motherduck/credentials.json`,'utf8')).motherduck_token;
let discardAck = process.argv.includes('--discard-ack');
const clientFactory = (): SqlClient => {
  const client = new Client({host:setup.host,port:5432,database:setup.database,user:'user',password:token,
    ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000,query_timeout:30000});
  return {connect:async()=>{try {await client.connect();} catch(error:any){receipt.connection_failure={code:error.code,message:String(error.message).replaceAll(token,'[redacted]').slice(0,600)};save();throw error;}},end:()=>client.end(),query:async(sql,values)=> {
    let result;
    try {result=await client.query(sql,values);} catch(error:any) {
      receipt.sql_failure={code:error.code,message:String(error.message).replaceAll(token,'[redacted]').slice(0,1200),operation:sql.slice(0,100)};save();throw error;
    }
    if(discardAck && /FROM md_run_flight\(/.test(sql)) {discardAck=false;receipt.simulated_lost_acknowledgements=(receipt.simulated_lost_acknowledgements??0)+1;save();throw Error('synthetic_lost_response');}
    return result;
  }};
};
const engine = new MotherDuckEngine({database:setup.database,host:setup.host,token,flightId:setup.flight_id,
  principal:'hosted-qualification',allowSubmission:true,maxRuntimeSeconds:120,dailySeconds:process.argv[2]==='cancel-running'?840:720,
  sourceSha256:setup.flight_source_sha256,requirementsSha256:setup.requirements_sha256,clientFactory});
const action=process.argv[2];
try {
  await engine.initialize();
  if(['query','materialize','derived','restore'].includes(action)) {
    let entry=receipt.jobs[action];
    if(!entry) {entry=receipt.jobs[action]={request_id:randomUUID(),attempted_at:new Date().toISOString()};save();}
    let result;
    if(action==='query') result=await engine.enqueue({request_id:entry.request_id,profile:'fixture',query:readFileSync('examples/01_discovery.sql','utf8')});
    if(action==='materialize') result=await engine.enqueue({columns:[{key:'id',logical_type:'BIGINT'},{key:'planned_mw',label:'Planned Capacity (MW)',logical_type:'DOUBLE'}],
      rows:[{id:'9007199254740993',planned_mw:125.5}],data_classification:'synthetic_fixture'},'import_table');
    if(action==='derived') {
      const parent=receipt.jobs.materialize?.status;
      if(parent?.status!=='completed') throw Error('materialize_must_complete');
      result=await engine.enqueue({request_id:entry.request_id,profile:'fixture',query:'SELECT id, planned_mw FROM input.projects',
        inputs:{projects:{result_id:parent.result_id}}});
    }
    if(action==='restore') {
      const parent=receipt.jobs.derived?.status;
      if(parent?.status!=='completed') throw Error('derived_must_complete');
      result=await engine.enqueue({bundle:await engine.call('export',{result_id:parent.result_id})},'import');
    }
    if (result.job_id) entry.submission=result;
    else {
      const operation=action==='materialize'?'import_table':'import';
      const job=await engine.connection(async client=>(await client.query(`SELECT CAST(id AS VARCHAR) AS id FROM ${engine.table('jobs')} WHERE operation=$1 ORDER BY created_at DESC LIMIT 1`,[operation])).rows[0]);
      entry.submission={job_id:job.id};entry.status=await engine.jobStatus(job.id);entry.output=result;
    }
    save();console.log(JSON.stringify({action,result:result.job_id?result:entry.status}));
  } else if(action==='status') {
    for(const [name,entry_] of Object.entries(receipt.jobs)) {
      if(process.argv[3] && process.argv[3]!==name)continue;
      const entry=entry_ as any;
      const id=entry.submission?.job_id;
      if(!id) continue;
      entry.status=await engine.jobStatus(id);
      console.log(JSON.stringify({action,job:name,result:entry.status}));save();
    }
  } else if(action==='read') {
    const resultId=receipt.jobs.derived?.status?.result_id??receipt.jobs.query?.status?.result_id;
    if(!resultId) throw Error('complete_a_query_first');
    const result=await engine.call('read_result',{result_id:resultId});
    const state=new MotherDuckStateBackend(engine), before=await state.read();
    if(!before.state) await state.write({snapshots:[],amendments:[],titles:{qualification:'durable correction history'}},before.version);
    const current=await state.read();
    let staleRefused=false;
    try {await state.write(current.state!, '0');} catch(error:any) {staleRefused=error.code==='revision_conflict';}
    const restoredId=receipt.jobs.restore?.status?.result_id;
    if(restoredId) {
      const restored=await engine.call('read_result',{result_id:restoredId});
      if(JSON.stringify(restored.rows)!==JSON.stringify(result.rows)||restored.content_sha256!==result.content_sha256)throw Error('restore_values_changed');
      receipt.checks.restore_roundtrip_exact=true;
      receipt.checks.restore_result_id=restoredId;
    }
    if(result.rows[0]?.id!=='9007199254740993')throw Error('large_integer_changed');
    receipt.checks.bigint_preserved=true;
    const archive=await engine.call('export',{result_id:resultId});
    writeFileSync(resolve(directory,'archive.json'),JSON.stringify(archive)+'\n',{mode:0o600});
    const counts=await engine.connection(async client=>(await client.query(`SELECT (SELECT count(*) FROM ${engine.table('jobs')})::INTEGER AS jobs,
      (SELECT count(*) FROM ${engine.table('results')})::INTEGER AS results,(SELECT count(*) FROM ${engine.table('app_state_history')})::INTEGER AS history,
      (SELECT coalesce(sum(reserved_seconds),0) FROM ${engine.table('flight_allowances')})::VARCHAR AS reserved_seconds`)).rows[0]);
    receipt.checks={...receipt.checks,fresh_native_read:true,stale_write_refused:staleRefused,durable_state_revision:current.version,
      row_count:result.row_count,rows:result.rows,columns:result.columns,archive_exported:true,...counts};save();console.log(JSON.stringify(receipt.checks));
  } else if(action==='logs') {
    for(const [name,entry_] of Object.entries(receipt.jobs)) {
      const entry=entry_ as any,id=entry.submission?.job_id;
      if(!id)continue;
      const job=await engine.transaction(false,async client=>(await client.query(`SELECT CAST(flight_run_number AS VARCHAR) AS n FROM ${engine.table('jobs')} WHERE id=$1::UUID`,[id])).rows[0]);
      if(!job?.n)continue;
      const rows=await engine.connection(async client=>(await client.query(`SELECT * FROM md_get_flight_logs(flight_id := '${setup.flight_id}'::UUID,run_number := ${job.n}::UBIGINT,"LIMIT" := 100,"ORDER" := 'desc')`)).rows);
      for(const row of rows)for(const value of Object.values(row))if(typeof value==='string'&&value.startsWith('{"schema": "sourcesql.hosted-flight-run.v1"')) {
        const report=JSON.parse(value.trim());if(report.job_id===id){entry.flight_report=report;save();console.log(JSON.stringify({job:name,report}));}
      }
    }
  } else if(action==='guards') {
    const reserve=await engine.connection(async client=>(await client.query(`SELECT coalesce(sum(reserved_seconds),0)::INTEGER AS n FROM ${engine.table('flight_allowances')}`)).rows[0].n);
    if(reserve!==720)throw Error('complete_the_bounded_run_plan_first');
    receipt.guard_request_id??=randomUUID();save();
    let refused=false;
    try {await engine.enqueue({request_id:receipt.guard_request_id,query:'SELECT 1 AS value',profile:'fixture'});} catch(error:any){refused=error.code==='budget_exhausted';}
    if(!refused)throw Error('budget_guard_not_observed');
    const job=await engine.connection(async client=>(await client.query(`SELECT CAST(id AS VARCHAR) AS id,status,dispatch_intent_at FROM ${engine.table('jobs')} WHERE request_id=$1::UUID`,[receipt.guard_request_id])).rows[0]);
    if(job.status!=='queued'||job.dispatch_intent_at)throw Error('budget_guard_dispatched_work');
    const cancellation=await engine.cancelJob(job.id);
    receipt.checks.budget_refused_before_submission=true;
    receipt.checks.queued_cancellation=cancellation;save();console.log(JSON.stringify({budget_refused:true,cancellation}));
  } else if(action==='cancel-running') {
    receipt.cancel_request_id??=randomUUID();save();
    const submitted=await engine.enqueue({request_id:receipt.cancel_request_id,query:'SELECT CAST(1 AS BIGINT) AS value',profile:'fixture'});
    const cancelled=await engine.cancelJob(submitted.job_id);
    receipt.jobs.cancellation={submission:submitted,status:cancelled};receipt.qualification_max_reserved_seconds=840;save();
    console.log(JSON.stringify({submitted,cancelled}));
  } else if(action==='summary') {
    const jobs=await engine.connection(async client=>(await client.query(`SELECT CAST(id AS VARCHAR) AS job_id,operation,status,CAST(flight_id AS VARCHAR) AS flight_id,
      CAST(flight_run_id AS VARCHAR) AS flight_run_id,CAST(flight_run_number AS VARCHAR) AS flight_run_number,flight_settled,result_id,cancel_requested,
      dispatch_intent_at FROM ${engine.table('jobs')} ORDER BY created_at`)).rows);
    const runs=[];
    for(const flight of [...new Set(jobs.map(job=>job.flight_id))]) {
      const details=await engine.connection(async client=>(await client.query(`SELECT CAST(run_id AS VARCHAR) AS run_id,CAST(flight_id AS VARCHAR) AS flight_id,
        flight_version,CAST(run_number AS VARCHAR) AS run_number,status,exit_code,CAST(created_at AS VARCHAR) AS created_at,
        CAST(started_at AS VARCHAR) AS started_at,CAST(ended_at AS VARCHAR) AS ended_at,
        epoch(ended_at-started_at) AS elapsed_seconds FROM md_list_flight_runs(flight_id := '${flight}'::UUID,"LIMIT" := 100)`)).rows);
      runs.push(...details);
    }
    receipt.final_jobs=jobs;receipt.platform_runs=runs;receipt.observed_run_seconds=runs.reduce((n,run)=>n+Number(run.elapsed_seconds??0),0);
    receipt.completed_at=new Date().toISOString();save();console.log(JSON.stringify({jobs:jobs.length,runs:runs.length,observed_run_seconds:receipt.observed_run_seconds,statuses:runs.map(run=>run.status),provider_calls:0}));
  } else throw Error('unknown_action');
} catch(error:any) {
  receipt.last_failure={action,at:new Date().toISOString(),code:error.code??error.name};save();
  console.error(JSON.stringify({action,failed:true,code:error.code??error.name}));process.exitCode=1;
}
