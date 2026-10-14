import type { App } from "@modelcontextprotocol/ext-apps";

type MessagingApp = Pick<
  App,
  "getHostCapabilities" | "getHostContext" | "sendMessage"
>;
type MessageResult = { isError?: boolean };
export type ChatGPTMessaging = {
  sendFollowUpMessage?: (options: {
    prompt: string;
  }) => Promise<MessageResult | void>;
};

export function chatGPTMessaging(): ChatGPTMessaging | undefined {
  return (window as Window & { openai?: ChatGPTMessaging }).openai;
}

export function agentMessenger(
  app: MessagingApp,
  compatibility?: ChatGPTMessaging,
): ((prompt: string) => Promise<MessageResult>) | undefined {
  const capabilities = app.getHostCapabilities();
  if (!capabilities || app.getHostContext()?.researchPreview === true)
    return undefined;

  const message = capabilities.message;
  // Older hosts advertise message: {} without the newer modality flags.
  // An explicit list of non-text modalities must not enable text messages.
  if (
    message &&
    (message.text !== undefined || Object.keys(message).length === 0)
  )
    return (prompt) =>
      app.sendMessage({
        role: "user",
        content: [{ type: "text", text: prompt }],
      });

  if (typeof compatibility?.sendFollowUpMessage === "function")
    return async (prompt) =>
      (await compatibility.sendFollowUpMessage!({ prompt })) ?? {};

  return undefined;
}
