import test from "node:test";
import assert from "node:assert/strict";
import { inlineGeneratedHtml } from "../scripts/inline-html.js";
test("standalone build inlines only exact generated scripts, styles and embedded fonts", () => {
  const html =
    '<html><link rel="stylesheet" href="./assets/style.css"><script type="module" src="./assets/app.js"></script></html>';
  const assets = new Map([
    ["assets/app.js", 'const value="</script><!--";'],
    [
      "assets/style.css",
      '@font-face{src:url("data:font/woff2;base64,AAA=")}body{color:black}',
    ],
  ]);
  const result = inlineGeneratedHtml(html, assets);
  assert.match(
    result,
    /<script type="module" >const value="\\x3C\/script>\\x3C!--";/,
  );
  assert.match(result, /data:font\/woff2/);
  assert.ok(!result.includes('src="./assets') && !result.includes("href="));
});
test("standalone build refuses non-generated script references and external CSS assets", () => {
  const html = '<script src="https://example.com/app.js"></script>';
  assert.throws(
    () => inlineGeneratedHtml(html, new Map([["app.js", "code"]])),
    /Unexpected generated asset/,
  );
  assert.throws(
    () =>
      inlineGeneratedHtml(
        '<link rel="stylesheet" href="./style.css">',
        new Map([
          ["style.css", "body{background:url(https://example.com/image.png)}"],
        ]),
      ),
    /external asset/,
  );
});
