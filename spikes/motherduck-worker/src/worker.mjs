import { Client } from "pg";
import { makeGateway } from "./gateway.mjs";
import definitions from "../generated/definitions.mjs";

export default makeGateway((env) => {
  const connection = new URL(`postgresql://${env.MOTHERDUCK_HOST}:5432/`);
  connection.username = "user";
  connection.password = env.MOTHERDUCK_TOKEN;
  connection.pathname = `/${encodeURIComponent(env.MOTHERDUCK_DB)}`;
  connection.searchParams.set("sslmode", "require");
  return new Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
}, definitions);
