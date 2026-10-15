import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createResearchApplication } from "../server/app.js";
import { createHttpApp } from "../server/http.js";

let application: ReturnType<typeof createHttpApp> | undefined;
let services: ReturnType<typeof createResearchApplication> | undefined;
export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  return new Promise((done) => {
    response.once("finish", done);
    response.once("close", done);
    try {
      const root = resolve(process.cwd(), ".vercel-assets");
      application ??= createHttpApp({
        environment: process.env,
        root,
        serverless: true,
        services: () =>
          (services ??= createResearchApplication({
            environment: process.env,
            root,
            serverless: true,
          }).catch((error) => {
            services = undefined;
            throw error;
          })),
      });
      application(request, response);
    } catch {
      response.statusCode = 503;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "Hosted app is not configured" }));
    }
  });
}
