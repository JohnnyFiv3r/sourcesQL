import test from "node:test";
import assert from "node:assert/strict";
import {
  McpUiHostContextSchema,
  McpUiInitializeResultSchema,
} from "@modelcontextprotocol/ext-apps";
import { inlineHeightLimitFor } from "../src/host-sizing.js";

test("a valid collapsed host still gets a positive inline content budget", () => {
  const collapsed = McpUiHostContextSchema.parse({
    displayMode: "inline",
    containerDimensions: { maxHeight: 0, maxWidth: 800 },
  });
  assert.equal(inlineHeightLimitFor(collapsed), 560);
  // Once measured, the host's real space budget takes effect.
  assert.equal(
    inlineHeightLimitFor({
      ...collapsed,
      containerDimensions: { maxHeight: 380, maxWidth: 800 },
    }),
    380,
  );
});

test("unmeasured dimensions recover without overriding positive host limits", () => {
  assert.equal(inlineHeightLimitFor({}), 560);
  assert.equal(
    inlineHeightLimitFor({ containerDimensions: { maxWidth: 800 } }),
    560,
  );
  for (const maxHeight of [0, -1, Number.NaN, Infinity, -Infinity])
    assert.equal(
      inlineHeightLimitFor({ containerDimensions: { maxHeight } }),
      560,
    );
  for (const maxHeight of [1, 240, 560, 900])
    assert.equal(
      inlineHeightLimitFor({ containerDimensions: { maxHeight } }),
      Math.min(560, maxHeight),
    );
});

test("fullscreen and ordinary local previews retain their unconstrained layout", () => {
  assert.equal(inlineHeightLimitFor({ displayMode: "fullscreen" }), null);
  assert.equal(inlineHeightLimitFor({ researchPreview: true }), null);
  assert.equal(
    inlineHeightLimitFor({
      researchPreview: true,
      researchInlineSizing: true,
      containerDimensions: { maxHeight: 320 },
    }),
    320,
  );
});

test("missing initialize context remains a protocol error rather than guessed host state", () => {
  const initialize = {
    protocolVersion: "2026-01-26",
    hostInfo: { name: "test", version: "1" },
    hostCapabilities: {},
  };
  assert.equal(
    McpUiInitializeResultSchema.safeParse(initialize).success,
    false,
  );
  assert.equal(
    McpUiInitializeResultSchema.safeParse({ ...initialize, hostContext: {} })
      .success,
    true,
  );
  assert.equal(inlineHeightLimitFor(undefined), null);
});
