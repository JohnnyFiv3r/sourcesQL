import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { ErrorRequestHandler } from "express";
import type { JWTVerifyGetKey } from "jose";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bearerMatches } from "./access.js";
import { researchAccess, type createResearchApplication } from "./app.js";
import {
  createOAuthVerifier,
  oauthChallenge,
  oauthProtectedResource,
  readOAuthConfiguration,
} from "./oauth.js";

type Services = Awaited<ReturnType<typeof createResearchApplication>>;
type HttpOptions = {
  environment: NodeJS.ProcessEnv;
  root: string;
  serverless?: boolean;
  services: () => Promise<Services>;
  oauthJwks?: JWTVerifyGetKey;
};
function publicOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) ||
    url.hostname.includes("..")
  )
    throw new Error(
      "Hosted public origins must be explicit HTTPS origins without credentials, paths or custom ports",
    );
  return url.origin;
}
export function createHttpApp(options: HttpOptions) {
  const { environment, root, serverless = false } = options;
  const access = researchAccess(environment, false, serverless);
  const oauth = readOAuthConfiguration(environment);
  if (oauth && access.mode !== "protected")
    throw new Error("OAuth requires protected owner access");
  if (oauth && !environment.RESEARCH_PUBLIC_ORIGIN)
    throw new Error("OAuth requires a stable RESEARCH_PUBLIC_ORIGIN");
  const metadata = oauth
    ? oauthProtectedResource(oauth, environment.RESEARCH_PUBLIC_ORIGIN!)
    : undefined;
  const oauthVerifier = oauth
    ? createOAuthVerifier(oauth, options.oauthJwks)
    : undefined;
  const port = Number(environment.PORT ?? 3117);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const bindHost = environment.RESEARCH_BIND_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(bindHost))
    throw new Error("RESEARCH_BIND_HOST must be 127.0.0.1 or 0.0.0.0");
  const hostedOrigins = [
    environment.RESEARCH_PUBLIC_ORIGIN,
    serverless && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}`
      : undefined,
  ]
    .filter(Boolean)
    .map((value) => publicOrigin(value!));
  const origins = serverless
    ? hostedOrigins
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        ...hostedOrigins,
      ];
  if (!origins.length)
    throw new Error(
      "Hosted HTTP requires RESEARCH_PUBLIC_ORIGIN or trusted VERCEL_URL",
    );
  const hosts = [...new Set(origins.map((origin) => new URL(origin).hostname))];
  const app = createMcpExpressApp({
    host: serverless ? "0.0.0.0" : bindHost,
    allowedHosts: hosts,
    jsonLimit: serverless ? "4mb" : "16mb",
  });
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      serverless &&
      (Number(req.headers["content-length"] ?? 0) > 4 * 1024 * 1024 ||
        (req.body !== undefined &&
          Buffer.byteLength(JSON.stringify(req.body)) > 4 * 1024 * 1024))
    ) {
      res.status(413).json({
        error:
          "Request exceeds this hosted transport's body allowance; use a smaller bundle or local Docker.",
      });
      return;
    }
    if (req.headers.origin && !origins.includes(req.headers.origin)) {
      res.status(403).send("Cross-origin requests are not allowed.");
      return;
    }
    next();
  });
  const index = readFileSync(join(root, "dist/index.html"), "utf8");
  app.get("/", (_req, res) => res.type("html").send(index));
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      mode: access.mode,
      ...(access.mode === "fixture-anonymous"
        ? { principal: "fixture-anonymous" }
        : {}),
    }),
  );
  if (metadata)
    app.get(
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ],
      (_req, res) => res.json(metadata),
    );
  app.all("/mcp", async (req, res) => {
    if (
      access.mode === "protected" &&
      !bearerMatches(
        req.headers.authorization,
        environment.RESEARCH_BEARER_TOKEN!,
      )
    ) {
      const verified = await oauthVerifier?.verify(req.headers.authorization);
      if (!verified?.authenticated) {
        const failure = req.headers.authorization
          ? verified?.reason
          : undefined;
        res.setHeader(
          "WWW-Authenticate",
          oauth
            ? oauthChallenge(environment.RESEARCH_PUBLIC_ORIGIN!, failure)
            : "Bearer",
        );
        res.status(failure === "insufficient_scope" ? 403 : 401).json({
          error: "Owner authorization required",
        });
        return;
      }
    }
    let server: ReturnType<Services["makeServer"]> | undefined;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server?.close();
    });
    try {
      server = (await options.services()).makeServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(503).json({
          error:
            "MCP service unavailable; inspect the same job or mutation IDs before retrying.",
        });
    }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (!res.headersSent)
      res.status(error?.type === "entity.too.large" ? 413 : 400).json({
        error:
          error?.type === "entity.too.large"
            ? "Request exceeds this transport's body allowance; use a smaller bundle or local Docker."
            : "Invalid request",
      });
  };
  app.use(errors);
  return app;
}
