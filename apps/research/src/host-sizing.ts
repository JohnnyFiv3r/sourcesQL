import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

const DEFAULT_INLINE_HEIGHT = 560;

export function inlineHeightLimitFor(
  context: McpUiHostContext | undefined,
): number | null {
  if (
    !context ||
    context.displayMode === "fullscreen" ||
    (context.researchPreview && !context.researchInlineSizing)
  )
    return null;

  const dimensions = context.containerDimensions;
  const maxHeight =
    dimensions && "maxHeight" in dimensions ? dimensions.maxHeight : undefined;
  // Hosts can initialize a collapsed iframe before measuring its content.
  // Returning zero would prevent a host awaiting a positive size from showing it.
  const budget =
    typeof maxHeight === "number" && Number.isFinite(maxHeight) && maxHeight > 0
      ? maxHeight
      : DEFAULT_INLINE_HEIGHT;
  return Math.min(DEFAULT_INLINE_HEIGHT, budget);
}
