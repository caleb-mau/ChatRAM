const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PATH = "/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function pageHarness(options = {}) {
  let now = 1000;
  let generated = Boolean(options.generating);
  let messages = [{ id: "initial", text: "Working on the task." }];
  let draft = options.draft || "";
  let clicked = 0;
  let interval = null;
  let wake = null;
  let state = null;
  let loaded = false;

  const visible = () => [1];
  const button = {
    disabled: false,
    getClientRects: visible,
    getAttribute: () => "false",
    click: () => { clicked++; draft = ""; }
  };
  const stopButton = { getClientRects: visible };
  const composer = {
    get innerText() { return draft; },
    set innerText(value) { draft = value; },
    getClientRects: visible,
    focus: () => {}
  };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === '[data-message-author-role="assistant"]') {
        return messages.map((message) => ({
          querySelector: () => ({ get innerText() { return message.text; } }),
          closest: () => ({ getAttribute: (attr) => attr === "data-message-id" ? message.id : null }),
          getAttribute: () => null
        }));
      }
      if (selector.includes("stop-button")) return generated ? [stopButton] : [];
      if (selector.includes('data-testid="send-button"')) return [button];
      return [];
    },
    querySelector: (selector) => selector.includes("#prompt-textarea") ? composer : null,
    execCommand: (_command, _showUI, prompt) => { draft = prompt; return true; }
  };
  const requests = [];
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (callback) => { wake = callback; } },
      sendMessage: (request, callback) => {
        requests.push(request.type);
        const reply = () => {
          switch (request.type) {
            case "chatram:auto:get": return { ok: true, state };
            case "chatram:auto:claim":
              if (!state?.active || state.status !== "waiting" || state.lastHandled === request.fingerprint) return { ok: false };
              state = { ...state, status: "sending", lastHandled: request.fingerprint };
              return { ok: true, state };
            case "chatram:auto:sent":
              state = { ...state, sendCount: state.sendCount + 1, status: state.mode === "once" ? "sent-once" : "waiting", active: state.mode !== "once" };
              return { ok: true, state };
            case "chatram:auto:stop":
              state = { ...state, active: false, status: request.status };
              return { ok: true, state };
            case "chatram:auto:error":
              state = { ...state, active: false, status: "error", error: request.error };
              return { ok: true, state };
            default: return { ok: false, error: "unknown" };
          }
        };
        callback(reply());
      }
    }
  };
  const code = fs.readFileSync(path.join(__dirname, "../src/automation-content.js"), "utf8");
  vm.runInNewContext(code, {
    window: { location: { pathname: PATH }, setInterval: (callback) => { interval = callback; } },
    document,
    chrome,
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    getComputedStyle: () => ({ visibility: "visible" }),
    Date: { now: () => now },
    setTimeout: (callback) => callback(),
    console
  }, { filename: "automation-content.js" });

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    get state() { return state; },
    get sends() { return clicked; },
    get draft() { return draft; },
    requests,
    async arm(mode = "continue") {
      await flush(); // Initial tab read must finish before the new popup arm.
      state = {
        active: true, mode, runId: "run1", status: "waiting", lastHandled: null,
        conversationPath: PATH, marker: "[[CHATRAM_COMPLETE]]", sendCount: 0, maxSends: 3,
        continuePrompt: "Keep working.", oncePrompt: "Give a summary.", criteria: "Run tests."
      };
      wake({ type: "chatram:auto:wake", state });
    },
    async tick(ms = 3500) {
      now += ms;
      interval();
      await flush();
    },
    setGenerating(value) { generated = value; },
    setText(value) { messages[messages.length - 1].text = value; },
    addAssistant(value) { messages.push({ id: "answer" + messages.length, text: value }); },
    navigate(url) {
      // Replace the pathname on the VM's window via a direct hook (see below).
      throw new Error("Navigation tested in background state tests instead.");
    }
  };
}

test("continue mode sends after a finished partial response, then stops at exact marker", async () => {
  const page = pageHarness({ generating: true });
  await page.arm();
  await page.tick();
  assert.equal(page.sends, 0);

  page.setGenerating(false);
  page.setText("Implementation underway, some tests still pending.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 1);
  assert.equal(page.state.sendCount, 1);
  assert.equal(page.state.active, true);

  page.addAssistant("Implementation and tests complete.\n[[CHATRAM_COMPLETE]]");
  await page.tick();
  await page.tick();
  assert.equal(page.state.status, "completed");
  assert.equal(page.sends, 1);
});

test("send once mode submits exactly one prompt, regardless of further answers", async () => {
  const page = pageHarness({ generating: true });
  await page.arm("once");
  page.setGenerating(false);
  page.setText("Done with the initial task.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 1);
  assert.equal(page.state.status, "sent-once");
  page.addAssistant("Second answer.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 1);
});

test("arming an idle chat does not submit again based on old completed messages", async () => {
  const page = pageHarness();
  await page.arm();
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 0);
  page.addAssistant("New answer to a manually submitted task.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 1);
});

test("a preexisting draft halts automation rather than overwriting it", async () => {
  const page = pageHarness({ generating: true, draft: "My private unfinished message" });
  await page.arm("once");
  page.setGenerating(false);
  page.setText("Current answer complete.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 0);
  assert.equal(page.draft, "My private unfinished message");
  assert.equal(page.state.status, "error");
});

test("marker inside fenced code does not count as completion", async () => {
  const page = pageHarness({ generating: true });
  await page.arm();
  page.setGenerating(false);
  page.setText("Here is a sample:\n~~~text\n[[CHATRAM_COMPLETE]]\n~~~\nStill working.");
  await page.tick();
  await page.tick();
  assert.equal(page.sends, 1);
  assert.equal(page.state.status, "waiting");
});