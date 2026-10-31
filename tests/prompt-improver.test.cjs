const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = path.join(__dirname, "../src");
const url = "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function harness() {
  let clipboard = "";
  const tabs = [];
  const store = new Map();
  const elements = new Map();
  const events = new Map();
  const defaultValues = {
    autoMode: "continue", autoMarker: "[[CHATRAM_COMPLETE]]",
    autoCriteria: "Make sure it works.",
    autoContinuePrompt: "Keep going and fix bugs.",
    autoOncePrompt: "Summarize the results.",
    autoMaxSends: "10"
  };
  for (const id of [
    ...Object.keys(defaultValues), "improverPanel", "improverStatus", "improverTarget",
    "improverManual", "improverCopyRequest", "improverApplyClipboard",
    "improverApplyManual", "improverCancel", "automationStatus"
  ]) {
    const e = {
      id, value: defaultValues[id] || "", textContent: "", dataset: {},
      hidden: id === "improverPanel", focus() {},
      dispatchEvent() {},
      addEventListener(event, callback) { events.set(id + ":" + event, callback); }
    };
    elements.set(id, e);
  }
  const buttons = ["autoCriteria", "autoContinuePrompt", "autoOncePrompt"].map((field) => ({
    dataset: { improveField: field },
    addEventListener(event, callback) { events.set("improve:" + field + ":" + event, callback); }
  }));
  const chrome = {
    tabs: {
      query: async () => [{ id: 12, url }],
      create: async (info) => { tabs.push(info); return { id: 99, ...info }; }
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: store.get(key) }),
        set: async (values) => { for (const [key, value] of Object.entries(values)) store.set(key, value); },
        remove: async (key) => store.delete(key)
      }
    },
    runtime: { sendMessage: (_message, callback) => callback({ ok: true, state: null }) },
    permissions: { contains: async () => true, request: async () => true }
  };
  const clipboardAPI = {
    writeText: async (text) => { clipboard = text; },
    readText: async () => clipboard
  };
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: () => buttons
  };
  const window = {};
  const context = { window, document, chrome, URL, navigator: { clipboard: clipboardAPI }, Event: class Event {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "prompt-improver-core.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, "prompt-improver.js"), "utf8"), context);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    store, tabs, elements, events,
    clipboard: (text) => { clipboard = text; },
    currentClipboard: () => clipboard,
    click: async (id) => { assert.ok(events.has(id + ":click"), id); await events.get(id + ":click")(); await flush(); await flush(); },
    flush
  };
}

test("prompt builder uses correct field, marker, context and length limits", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "prompt-improver-core.js"), "utf8"), context);
  const core = context.window.ChatRAMPromptImprover;
  const result = core.buildPrompt("autoCriteria", "Do everything.", {
    mode: "continue", marker: "[[CHATRAM_COMPLETE]]", continuePrompt: "Fix tests."
  });
  assert.match(result, /Completion standards/);
  assert.match(result, /Do everything/);
  assert.match(result, /Fix tests/);
  assert.match(result, /\[\[CHATRAM_COMPLETE\]\]/);
  assert.match(result, /ONLY the improved text/);
  assert.throws(() => core.buildPrompt("unknown", "Something", {}));
  assert.throws(() => core.buildPrompt("autoCriteria", " ", {}));
});

test("improvement preserves original field, opens new chat, and applies user-copied result", async () => {
  const h = harness();
  await h.flush();
  await h.click("improve:autoCriteria");
  assert.equal(h.elements.get("autoCriteria").value, "Make sure it works.");
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, "https://chatgpt.com/");
  assert.match(h.currentClipboard(), /Make sure it works/);
  assert.ok(h.store.get("chatram:improve:12"));
  h.clipboard("Confirm all relevant tests pass and the implemented behavior matches the requirements.");
  await h.click("improverApplyClipboard");
  assert.equal(h.elements.get("autoCriteria").value, "Confirm all relevant tests pass and the implemented behavior matches the requirements.");
  assert.equal(h.store.get("chatram:auto:draft:12").criteria, h.elements.get("autoCriteria").value);
  assert.equal(h.store.has("chatram:improve:12"), false);
});

test("initial improvement request is not mistakenly applied as rewritten text", async () => {
  const h = harness();
  await h.flush();
  await h.click("improve:autoContinuePrompt");
  await h.click("improverApplyClipboard");
  assert.equal(h.elements.get("autoContinuePrompt").value, "Keep going and fix bugs.");
  assert.match(h.elements.get("improverStatus").textContent, /still contains the improvement request/);
});

test("refuses to overwrite a draft changed since the helper launched", async () => {
  const h = harness();
  await h.flush();
  await h.click("improve:autoOncePrompt");
  h.elements.get("autoOncePrompt").value = "This is my newer work.";
  h.clipboard("Rewritten follow-up response.");
  await h.click("improverApplyClipboard");
  assert.equal(h.elements.get("autoOncePrompt").value, "This is my newer work.");
  assert.match(h.elements.get("improverStatus").textContent, /changed the original prompt/);
});

test("long response is not silently truncated and can be replaced manually", async () => {
  const h = harness();
  await h.flush();
  await h.click("improve:autoCriteria");
  h.clipboard("a".repeat(1501));
  await h.click("improverApplyClipboard");
  assert.equal(h.elements.get("autoCriteria").value, "Make sure it works.");
  assert.match(h.elements.get("improverStatus").textContent, /only accepts 1500/);
  h.elements.get("improverManual").value = "Run all required validation checks.";
  await h.click("improverApplyManual");
  assert.equal(h.elements.get("autoCriteria").value, "Run all required validation checks.");
});