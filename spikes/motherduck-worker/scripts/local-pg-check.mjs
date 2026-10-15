import { Client } from "pg";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { makeGateway } from "../src/gateway.mjs";
import definitions from "../generated/definitions.mjs";

const credential = JSON.parse(readFileSync(`${homedir()}/.motherduck/credentials.json`, "utf8"));
const env = {MOTHERDUCK_TOKEN:credential.motherduck_token, MOTHERDUCK_DB:"sourcesql_probe_20261014",
  MOTHERDUCK_HOST:"pg.us-east-1-aws.motherduck.com", GATEWAY_TOKEN:"local-process-only",
  ALLOW_FLIGHT_PROVISIONING:"true", ALLOW_FLIGHT_SUBMISSION:"false"};
const gateway = makeGateway((env)=>new Client({host:env.MOTHERDUCK_HOST,port:5432,
  database:env.MOTHERDUCK_DB,user:"user",password:env.MOTHERDUCK_TOKEN,
  ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000,query_timeout:15000}),definitions);
const receipt = {evidence:"local_node_postgres_probe",created_at:new Date().toISOString(),
  hosted_runtime_tested:false,flight_submissions:0,operations:[]};
for (const [path,body] of [["/connection",undefined],["/flight/create",{kind:"tiny"}]]) {
  const res=await gateway.fetch(new Request(`https://local.invalid${path}`,{
    method:body?"POST":"GET",headers:{authorization:`Bearer ${env.GATEWAY_TOKEN}`},
    ...(body?{body:JSON.stringify(body)}:{})}),env);
  const data=await res.json(); receipt.operations.push({path,status:res.status,data});
  if (res.status !== 200) break;
}
const directory=new URL("../../../artifacts/motherduck-probe/",import.meta.url);
mkdirSync(directory,{recursive:true});
writeFileSync(new URL("local-pg-baseline.json",directory),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt));
