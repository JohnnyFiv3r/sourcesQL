import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { uiResourceUri } from "../server/ui-resource.js";

const root = fileURLToPath(new URL("../", import.meta.url));
// Explicitly retain public bundles already referenced by installed ChatGPT apps.
// Never discover archive inputs by scanning a directory of operator artifacts.
const historicalBundles = [
  {
    filename: "research-dfe1c3e8aec7c276.html",
    sha256: "dfe1c3e8aec7c276ab2e0d62ddb0df68f46efc35ebd09997c4bb4dffff644f78",
  },
  {
    filename: "research-66390a91a9d5271f.html",
    sha256: "66390a91a9d5271f9cd6e570cede89b021d9274e70f1400d1f0eea686544cad1",
  },
  {
    filename: "research-b1349a13ba4d1fbe.html",
    sha256: "b1349a13ba4d1fbe273ddff6a69c797f6a2449fec2fb2e0e3125e685847aade6",
  },
  {
    filename: "research-be8725d56a366d19.html",
    sha256: "be8725d56a366d19ecd66b4e7882b4b854b99fe8625e9b41b3f79ebdf8e72418",
  },
  {
    filename: "research-b5ab74c900f06fdb.html",
    sha256: "b5ab74c900f06fdbe7aa0015c25fee66dbc09b4a9df16a152d0aaef1d0b2831c",
  },
] as const;

export async function packageVercelAssets(
  output = join(root, ".vercel-assets"),
  input = root,
) {
  const html = await readFile(join(input, "dist/research.html"), "utf8");
  const version = uiResourceUri(html).match(
    /research-([a-f0-9]{16})\.html$/,
  )![1];
  const assets = new Map([
    ["dist/research.html", html],
    ["dist/index.html", await readFile(join(input, "dist/index.html"), "utf8")],
    [`.ui-builds/research-${version}.html`, html],
    [
      "fixtures/water-procurement.json",
      await readFile(join(input, "fixtures/water-procurement.json"), "utf8"),
    ],
  ]);
  for (const { filename, sha256 } of historicalBundles) {
    const archived = await readFile(
      join(input, "ui-history", filename),
      "utf8",
    );
    if (
      createHash("sha256").update(archived).digest("hex") !== sha256 ||
      uiResourceUri(archived) !== `ui://sourcesql/${filename}`
    )
      throw new Error(
        `Historical UI bundle content hash mismatch: ${filename}`,
      );
    assets.set(`.ui-builds/${filename}`, archived);
  }
  await rm(output, { recursive: true, force: true });
  const hashes: Record<string, string> = {};
  for (const [path, body] of assets) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body, { mode: 0o444 });
    hashes[path] = createHash("sha256").update(body).digest("hex");
  }
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        schema: "sourcesql.vercel-assets.v1",
        resource_uri: uiResourceUri(html),
        files: hashes,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o444 },
  );
  console.log(
    `Packaged ${assets.size} immutable server assets; resource ${uiResourceUri(html)}`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await packageVercelAssets();
