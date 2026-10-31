const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(fetchImpl, settings = { enabled: true, historyLimit: 40, blockOlderPages: true }) {
  const listeners = {};
  const storage = new Map([["__chatgpt_speedup_settings_v1", JSON.stringify(settings)]]);
  const calls = [];
  const win = {
    fetch(input, init) {
      calls.push({ input, init });
      return fetchImpl(input, init);
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    addEventListener(name, callback) { listeners[name] = callback; },
    postMessage() {},
    crossOriginIsolated: false
  };
  const code = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  vm.runInNewContext(code, {
    window: win, URL, Request, Headers, Response, performance: {},
    console, Date, JSON, Set, Number, Object
  }, { filename: "main.js" });
  return { win, calls, listeners };
}

test("unrelated GET requests return the original promise without wrapping", async () => {
  const native = Promise.resolve(new Response("ok"));
  const { win, calls } = setup(() => native);
  const result = win.fetch("/backend-api/other-service");
  assert.equal(result, native);
  assert.equal((await result).status, 200);
  assert.equal(calls.length, 1);
});

test("POST requests use the original promise identity without body modifications", async () => {
  const native = Promise.resolve(new Response("ok"));
  const { win, calls } = setup(() => native);
  const init = { method: "POST", body: JSON.stringify({ text: "hello" }) };
  const result = win.fetch("/backend-api/conversations/id", init);
  assert.equal(result, native);
  assert.equal(calls[0].init, init);
});

test("native rejected fetch promises are propagated without replacements", async () => {
  const failure = new TypeError("Failed to fetch");
  const native = Promise.reject(failure);
  const { win } = setup(() => native);
  const result = win.fetch("https://chatgpt.com/backend-api/unrelated");
  assert.equal(result, native);
  await assert.rejects(result, (error) => error === failure);
});

test("disabled ChatRAM does not modify any fetch", async () => {
  const native = Promise.resolve(new Response("ok"));
  const { win } = setup(() => native, { enabled: false });
  assert.equal(win.fetch("/backend-api/conversations/some-id?num_turns=100"), native);
});

test("ChatGPT conversation GETs still apply the history window", async () => {
  const data = {
    messages: Array.from({ length: 65 }, (_, index) => ({ id: "message-" + index })),
    page_info: { has_previous_page: true }
  };
  const { win, calls } = setup(() => Promise.resolve(new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" }
  })));
  const result = await win.fetch("https://chatgpt.com/backend-api/conversations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?num_turns=100");
  const parsed = await result.json();
  assert.equal(parsed.messages.length, 40);
  assert.equal(parsed.messages[0].id, "message-25");
  assert.equal(parsed.page_info.has_previous_page, false);
  assert.equal(new URL(calls[0].input).searchParams.get("num_turns"), "40");
});
