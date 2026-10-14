import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveUiBundle } from "../server/ui-resource.js";
import { inlineGeneratedHtml } from "./inline-html.js";
await mkdir("dist", { recursive: true });
for (const input of ["research.html", "index.html"]) {
  const generated = await build({
    configFile: false,
    base: "./",
    publicDir: false,
    build: {
      write: false,
      outDir: "dist",
      assetsInlineLimit: () => true,
      cssCodeSplit: false,
      chunkSizeWarningLimit: 100000000,
      rollupOptions: { input, output: { inlineDynamicImports: true } },
    },
  });
  if (Array.isArray(generated) || !("output" in generated))
    throw new Error("Expected one generated widget bundle");
  const assets = new Map(
    generated.output.map((item) => [
      item.fileName,
      item.type === "chunk"
        ? item.code
        : typeof item.source === "string"
          ? item.source
          : Buffer.from(item.source).toString("utf8"),
    ]),
  );
  const html = assets.get(input);
  if (!html) throw new Error(`Generated HTML missing: ${input}`);
  await writeFile(join("dist", input), inlineGeneratedHtml(html, assets));
}
console.log(`MCP UI resource: ${await archiveUiBundle("dist/research.html")}`);
