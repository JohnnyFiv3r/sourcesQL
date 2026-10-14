// Only exact files produced by this build can become executable inline assets.
// No globs, public paths, network fetching or user-controlled patterns.
export function inlineGeneratedHtml(
  html: string,
  assets: ReadonlyMap<string, string>,
): string {
  function asset(reference: string, extension: string) {
    const name = reference.startsWith("./") ? reference.slice(2) : reference;
    if (!name.endsWith(extension) || !assets.has(name))
      throw new Error(`Unexpected generated asset: ${reference}`);
    return assets.get(name)!;
  }
  html = html.replace(
    /<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/g,
    (_tag, before: string, source: string, after: string) => {
      const code = asset(source, ".js").replace(/<(\/script|!--)/gi, "\\x3C$1");
      return `<script${before}${after}>${code}</script>`;
    },
  );
  html = html.replace(/<link\b[^>]*>/g, (tag) => {
    const reference = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (/\brel="stylesheet"/.test(tag) && reference) {
      const css = asset(reference, ".css").replace(/<\/style/gi, "\\3C /style");
      for (const match of css.matchAll(/url\(([^)]+)\)/gi)) {
        const url = match[1].trim().replace(/^["']|["']$/g, "");
        if (!url.startsWith("data:") && !url.startsWith("#"))
          throw new Error("Generated CSS contains an external asset");
      }
      return `<style>${css}</style>`;
    }
    throw new Error("Unexpected generated link asset");
  });
  if (/<script\b[^>]*\bsrc=/i.test(html))
    throw new Error("Standalone widget contains an external script");
  return html;
}
