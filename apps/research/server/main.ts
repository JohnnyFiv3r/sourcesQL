import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createResearchApplication } from "./app.js";
import { createHttpApp } from "./http.js";

const environment = process.env;
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--stdio")) {
  const services = await createResearchApplication({
    environment,
    root,
    stdio: true,
  });
  await services.makeServer().connect(new StdioServerTransport());
} else {
  let pending: ReturnType<typeof createResearchApplication> | undefined;
  const services = () =>
    (pending ??= createResearchApplication({ environment, root }).catch(
      (error) => {
        pending = undefined;
        throw error;
      },
    ));
  const app = createHttpApp({ environment, root, services });
  const port = Number(environment.PORT ?? 3117),
    host = environment.RESEARCH_BIND_HOST ?? "127.0.0.1";
  app.listen(port, host, () =>
    console.error(
      `sourcesQL research app: http://127.0.0.1:${port} | MCP: /mcp`,
    ),
  );
}
