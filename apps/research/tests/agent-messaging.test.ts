import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "@modelcontextprotocol/ext-apps";
import {
  agentMessenger,
  type ChatGPTMessaging,
} from "../src/agent-messaging.js";

function host(
  capabilities: ReturnType<App["getHostCapabilities"]>,
  preview = false,
): Parameters<typeof agentMessenger>[0] {
  return {
    getHostCapabilities: () => capabilities,
    getHostContext: () => ({ researchPreview: preview }),
    sendMessage: async () => {
      throw new Error("Unexpected standard bridge call");
    },
  };
}

test("unsupported, disconnected and preview hosts cannot enable Ask agent", () => {
  const compatibility = { sendFollowUpMessage: async () => {} };
  assert.equal(agentMessenger(host({})), undefined);
  assert.equal(agentMessenger(host({ message: { image: {} } })), undefined);
  assert.equal(agentMessenger(host(undefined), compatibility), undefined);
  assert.equal(
    agentMessenger(host({ message: { text: {} } }, true), compatibility),
    undefined,
  );
  assert.equal(agentMessenger(host({}, true), compatibility), undefined);
});

test("ChatGPT compatibility messaging works when the standard flag is absent, including late availability", async () => {
  const app = host({ serverTools: {} });
  let compatibility: ChatGPTMessaging | undefined;
  assert.equal(agentMessenger(app, compatibility), undefined);
  const prompts: string[] = [];
  compatibility = {
    async sendFollowUpMessage({ prompt }) {
      assert.equal(this, compatibility, "Preserve the runtime method binding");
      prompts.push(prompt);
    },
  };
  const send = agentMessenger(app, compatibility);
  assert.ok(send);
  assert.deepEqual(await send("Research this selected row"), {});
  assert.deepEqual(prompts, ["Research this selected row"]);
  compatibility = { sendFollowUpMessage: async () => ({ isError: true }) };
  assert.equal(
    (await agentMessenger(app, compatibility)!("Rejected")).isError,
    true,
  );
});

test("standard messaging is preferred and rejection or timeout never sends a duplicate via the compatibility bridge", async () => {
  let standardCalls = 0;
  let compatibilityCalls = 0;
  const compatibility = {
    sendFollowUpMessage: async () => {
      compatibilityCalls++;
    },
  };
  const app = host({ message: { text: {} } });
  app.sendMessage = async ({ role, content }) => {
    standardCalls++;
    assert.equal(role, "user");
    assert.deepEqual(content, [{ type: "text", text: "Question" }]);
    return { isError: true };
  };
  assert.equal(
    (await agentMessenger(app, compatibility)!("Question")).isError,
    true,
  );
  app.sendMessage = async () => {
    standardCalls++;
    throw new Error("Timed out after dispatch");
  };
  await assert.rejects(
    agentMessenger(app, compatibility)!("Question"),
    /Timed out/,
  );
  assert.equal(standardCalls, 2);
  assert.equal(compatibilityCalls, 0);
});
