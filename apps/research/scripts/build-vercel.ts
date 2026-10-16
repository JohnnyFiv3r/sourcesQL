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
    filename: "research-048e54fb9a70888e.html",
    sha256: "048e54fb9a70888eef16c2694fe4a24a7d7a7ccadb7b6b29592933276721e598",
  },
  {
    filename: "research-9fa11ff58ed34fd6.html",
    sha256: "9fa11ff58ed34fd69608d172b43004a532aa9ef09ff9d481a3a883d39c28e462",
  },
  {
    filename: "research-2511fe6d0adf4f69.html",
    sha256: "2511fe6d0adf4f693803ff5bd8e4760f3de0cae78593150ddb827c7d521c6475",
  },
  {
    filename: "research-a19abdd86f97fd03.html",
    sha256: "a19abdd86f97fd039aebb8d08162ef060f17adeef2443b14c7dac6e13d14ebf8",
  },
  {
    filename: "research-3ad849c41d019ecb.html",
    sha256: "3ad849c41d019ecb75b19fa78fda88007ce83eed7fee81a8525418b03556e553",
  },
  {
    filename: "research-9b396ddfaead18f3.html",
    sha256: "9b396ddfaead18f337375ba5fb6d714b68c8ce3e475c641190e7a159188b0bb4",
  },
  {
    filename: "research-2e96c79d74441904.html",
    sha256: "2e96c79d744419047ab91e5e62f5eee055249466666db306b41802914dbf8b6a",
  },
  {
    filename: "research-a0b4eab71ba980c1.html",
    sha256: "a0b4eab71ba980c15066db41a24a7599be40e0ce4c3d07a0a0c1d866790804ae",
  },
  {
    filename: "research-a8517535856c8aa3.html",
    sha256: "a8517535856c8aa3ca2dab059a4734075895659fd78f2d0e3c7eb9e4bcb5c25a",
  },
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
