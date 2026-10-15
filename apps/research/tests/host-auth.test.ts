import test from "node:test";
import assert from "node:assert/strict";
import { tokenSubmitter } from "../src/host-auth.js";

function view(value = "") {
  return {
    value,
    busy: false,
    error: "",
    success: false,
    readToken() {
      return this.value;
    },
    clearToken() {
      this.value = "";
    },
    setBusy(value: boolean) {
      this.busy = value;
    },
    showError(value: string) {
      this.error = value;
    },
    connected() {
      this.success = true;
    },
  };
}

test("empty tokens show an inline error without a connection attempt", async () => {
  const state = view("  ");
  let calls = 0;
  await tokenSubmitter(state, async () => {
    calls++;
  })();
  assert.equal(calls, 0);
  assert.equal(state.value, "");
  assert.equal(state.error, "Enter your server access token.");
  assert.equal(state.success, false);
});

test("submission clears the field before connecting and ignores duplicate pending submits", async () => {
  const state = view("  synthetic-page-token  ");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const submit = tokenSubmitter(state, async (token) => {
    assert.equal(state.value, "");
    assert.equal(state.busy, true);
    calls.push(token);
    await pending;
  });
  const first = submit();
  await submit();
  assert.deepEqual(calls, ["synthetic-page-token"]);
  assert.equal(state.success, false);
  finish();
  await first;
  assert.equal(state.success, true);
  assert.equal(state.busy, false);
  assert.equal(state.error, "");
});

test("failed credentials never reach the error text and a fresh token can retry", async () => {
  const state = view("synthetic-sensitive-value");
  let calls = 0;
  const submit = tokenSubmitter(state, async (token) => {
    calls++;
    if (calls === 1) throw new Error(`Authorization: Bearer ${token}`);
    assert.equal(token, "synthetic-replacement");
  });
  await submit();
  assert.equal(state.success, false);
  assert.equal(state.busy, false);
  assert.equal(state.value, "");
  assert.equal(
    state.error,
    "Unable to connect. Check your access token and connection, then try again.",
  );
  assert.ok(!state.error.includes("synthetic-sensitive-value"));
  state.value = "synthetic-replacement";
  await submit();
  assert.equal(calls, 2);
  assert.equal(state.success, true);
  assert.equal(state.error, "");
});
