import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const LEGACY_RESOURCE_URI = "ui://research-legacy/research.html";
export const RESOURCE_TEMPLATE = "ui://sourcesql/research-{version}.html";

export function uiResourceUri(html: string): string {
  const version = createHash("sha256").update(html).digest("hex").slice(0, 16);
  return `ui://sourcesql/research-${version}.html`;
}

function archivePath(htmlPath: string, uri: string): string {
  const match =
    /^ui:\/\/(?:sourcesql|open-webql|research-legacy)\/research-([a-f0-9]{16})\.html$/.exec(uri);
  if (!match) throw new Error("Invalid UI resource version");
  return resolve(
    dirname(htmlPath),
    "../.ui-builds",
    `research-${match[1]}.html`,
  );
}

// Keep published bundles outside dist so rebuilding does not break old chats.
export async function archiveUiBundle(htmlPath: string): Promise<string> {
  const html = await readFile(htmlPath, "utf8");
  const uri = uiResourceUri(html);
  const path = archivePath(htmlPath, uri);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html);
  return uri;
}

export async function readArchivedUiBundle(
  htmlPath: string,
  uri: string,
): Promise<string> {
  const html = await readFile(archivePath(htmlPath, uri), "utf8");
  if (
    uiResourceUri(html) !== uri &&
    uiResourceUri(html).replace("sourcesql", "research-legacy") !== uri &&
    uiResourceUri(html).replace("sourcesql", "open-webql") !== uri
  )
    throw new Error("UI resource version does not match its content");
  return html;
}
