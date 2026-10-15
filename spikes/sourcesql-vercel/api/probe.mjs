import { Client } from "pg";
import { makeGateway } from "../lib/gateway.mjs";
import definitions from "../lib/definitions.mjs";

const gateway = makeGateway((env) => new Client({host:env.MOTHERDUCK_HOST,
  port:5432, database:env.MOTHERDUCK_DB, user:"user", password:env.MOTHERDUCK_TOKEN,
  ssl:{rejectUnauthorized:true}, connectionTimeoutMillis:5000, query_timeout:15000}), definitions);

export default async function handler(req, res) {
  try {
    const chunks=[];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((n,c)=>n+c.length,0)>4096) return res.status(413).json({error:"request_too_large"});
    }
    const url = new URL(`https://${req.headers.host}${req.url}`);
    const originalPath = url.searchParams.get("__probe_path");
    if (originalPath) { url.pathname = originalPath; url.searchParams.delete("__probe_path"); }
    const request = new Request(url, {
      method:req.method, headers:req.headers,
      ...(chunks.length ? {body:Buffer.concat(chunks)} : {})
    });
    const result=await gateway.fetch(request,process.env);
    res.status(result.status);
    for (const [name,value] of result.headers) res.setHeader(name,value);
    res.send(await result.text());
  } catch {
    res.status(502).json({error:"probe_transport_failed",automatic_retry:false});
  }
}
