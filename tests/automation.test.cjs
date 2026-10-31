const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const path = require("node:path");

function startWorker() {
  const contents = new Map();
  const tabs = new Map([
    [1, { id: 1, url: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }],
    [2, { id: 2, url: "https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }],
    [3, { id: 3, url: "https://example.com" }]
  ]);
  let handler = null;
  let closed = null;
  const chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: contents.get(key) }),
        set: async (values) => { for (const [key, value] of Object.entries(values)) contents.set(key, value); },
        remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) contents.delete(key); }
      }
    },
    tabs: {
      get: async (id) => tabs.get(id),
      sendMessage: async () => undefined,
      onRemoved: { addListener: (fn) => { closed = fn; } }
    },
    runtime: { onMessage: { addListener: (fn) => { handler = fn; } } }
  };

  const code = fs.readFileSync(path.join(__dirname, "../src/automation-background.js"), "utf8");
  vm.runInNewContext(code, { chrome, URL, crypto: webcrypto, console }, { filename: "automation-background.js" });
  assert.equal(typeof handler, "function");

  return {
    contents,
    async dispatch(request, sender = {}) {
      return new Promise((resolve) => {
        const listening = handler(request, sender, resolve);
        assert.equal(listening, true);
      });
    },
    close: (tabId) => closed(tabId)
  };
}

test("different tabs have independent automation configurations and progress", async () => {
  const worker = startWorker();
  const first = await worker.dispatch({
    type: "chatram:auto:start", tabId: 1,
    config: { mode: "continue", marker: "[[TASK_DONE]]", maxSends: 3, criteria: "Tests pass." }
  });
  const second = await worker.dispatch({
    type: "chatram:auto:start", tabId: 2,
    config: { mode: "once", oncePrompt: "Show the test results." }
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.state.runId, second.state.runId);
  assert.equal(first.state.marker, "[[TASK_DONE]]");
  assert.equal(second.state.mode, "once");

  const sender = { tab: { id: 1 } };
  const claim = await worker.dispatch({ type: "chatram:auto:claim", runId: first.state.runId, fingerprint: "response1" }, sender);
  assert.equal(claim.ok, true);
  const duplicate = await worker.dispatch({ type: "chatram:auto:claim", runId: first.state.runId, fingerprint: "response1" }, sender);
  assert.equal(duplicate.ok, false);
  const sent = await worker.dispatch({ type: "chatram:auto:sent", runId: first.state.runId, fingerprint: "response1" }, sender);
  assert.equal(sent.state.sendCount, 1);
  assert.equal(sent.state.active, true);

  const independent = await worker.dispatch({ type: "chatram:auto:get", tabId: 2 });
  assert.equal(independent.state.sendCount, 0);
  assert.equal(independent.state.active, true);
});

test("send-once disarms after one submission", async () => {
  const worker = startWorker();
  const result = await worker.dispatch({ type: "chatram:auto:start", tabId: 2, config: { mode: "once", oncePrompt: "Summarize." } });
  const sender = { tab: { id: 2 } };
  await worker.dispatch({ type: "chatram:auto:claim", runId: result.state.runId, fingerprint: "response1" }, sender);
  const sent = await worker.dispatch({ type: "chatram:auto:sent", runId: result.state.runId, fingerprint: "response1" }, sender);
  assert.equal(sent.state.status, "sent-once");
  assert.equal(sent.state.active, false);
  assert.equal((await worker.dispatch({ type: "chatram:auto:claim", runId: result.state.runId, fingerprint: "response2" }, sender)).ok, false);
});

test("manual stop is preserved and prevents stale errors from restarting or replacing it", async () => {
  const worker = startWorker();
  const start = await worker.dispatch({ type: "chatram:auto:start", tabId: 1, config: { mode: "continue" } });
  const stopped = await worker.dispatch({ type: "chatram:auto:stop", tabId: 1 });
  assert.equal(stopped.state.status, "stopped");
  assert.equal(stopped.state.active, false);
  const stale = await worker.dispatch({ type: "chatram:auto:error", runId: start.state.runId, error: "late callback" }, { tab: { id: 1 } });
  assert.equal(stale.state.status, "stopped");
});

test("cross-tab content script actions cannot alter another tab", async () => {
  const worker = startWorker();
  const result = await worker.dispatch({ type: "chatram:auto:start", tabId: 1, config: { mode: "continue" } });
  const forged = await worker.dispatch({ type: "chatram:auto:claim", tabId: 2, runId: result.state.runId, fingerprint: "response1" }, { tab: { id: 1 } });
  assert.equal(forged.ok, false);
  assert.equal((await worker.dispatch({ type: "chatram:auto:get", tabId: 1 })).state.sendCount, 0);
});

test("requires a ChatGPT conversation, and a follow-up for send-once", async () => {
  const worker = startWorker();
  assert.equal((await worker.dispatch({ type: "chatram:auto:start", tabId: 3, config: { mode: "continue" } })).ok, false);
  assert.equal((await worker.dispatch({ type: "chatram:auto:start", tabId: 1, config: { mode: "once" } })).ok, false);
});

test("closed tabs purge session state and uncommitted drafts", async () => {
  const worker = startWorker();
  await worker.dispatch({ type: "chatram:auto:start", tabId: 1, config: { mode: "continue" } });
  worker.contents.set("chatram:auto:draft:1", { mode: "continue" });
  worker.close(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.contents.has("chatram:auto:1"), false);
  assert.equal(worker.contents.has("chatram:auto:draft:1"), false);
});