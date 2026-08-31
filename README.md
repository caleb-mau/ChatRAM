# ChatRAM

> **Memory Saver for ChatGPT.** Keep long conversations usable without letting one tab swallow gigabytes of memory.

ChatRAM is a small, open-source Chromium extension built for one specific problem: **very long ChatGPT conversations can become extremely memory-heavy**.

Instead of hiding old messages after ChatGPT has already loaded them, ChatRAM limits how much conversation history reaches the live ChatGPT client in the first place. Your full conversation stays saved in ChatGPT.

## Results so far

ChatRAM is still early, but the difference on large conversations can be substantial.

| Test | Before | After | Result |
| --- | ---: | ---: | ---: |
| Very large conversation, Chrome process/task memory | **4.5 GB** | **~1.0 GB** | **~78% lower** |
| Long conversation, live V8 JS heap | **577 MB** | **164 MB** | **~72% lower JS heap** |
| History loaded in the same JS-heap test | **101 items** | **40 items** | bounded to configured window |

These are real measurements from development testing, not guaranteed results. Savings depend on the conversation, browser version, message sizes, attachments, active ChatGPT features, and the history window you choose.

> **Important:** `JS heap` is not the same thing as Chrome Task Manager's total tab RAM. ChatRAM labels those measurements separately and does not pretend they are interchangeable.

## Install

ChatRAM is currently distributed directly from GitHub.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the ChatRAM folder containing `manifest.json`.
6. Open a long ChatGPT conversation.
7. Open ChatRAM from the extensions menu and click **Reload current tab**.

```bash
git clone https://github.com/caleb-mau/ChatRAM.git
```

Chrome is the primary target. ChatRAM should also work in Chromium-based browsers such as Edge, Brave, and Arc.

## How to use it

ChatRAM defaults to:

- **Memory Saver:** on
- **Recent history window:** 40
- **Stop older pages loading:** on

For most people, leaving the defaults alone is fine.

When you click **Reload current tab**, ChatRAM captures a memory diagnostic, reloads the conversation, and lets ChatGPT rebuild the page with only the configured recent-history window live in memory.

The popup also shows the most recent intercepted history load, for example:

```text
101 → 40 items (paginated history)
```

That is the easiest way to confirm ChatRAM actually intercepted the conversation load.

## What ChatRAM actually does

A huge ChatGPT conversation is not expensive only because there are lots of visible DOM elements. The browser can also retain the underlying conversation data, React state, caches, branches, and other objects in memory.

Simply deleting old message elements from the page does not guarantee that memory is released, and ChatGPT can recreate those elements from retained client state.

ChatRAM works earlier in the pipeline:

```text
ChatGPT requests conversation history
              ↓
      ChatRAM intercepts it
              ↓
   history payload is bounded
              ↓
ChatGPT receives only the recent window
              ↓
 less conversation state stays live in the tab
```

For ChatGPT's current paginated conversation format, ChatRAM can:

- clamp the requested recent-history window;
- trim oversized `messages[]` responses before ChatGPT consumes them;
- stop older history pages from continuously accumulating in memory.

For older conversation responses that use a full `mapping` graph, ChatRAM can:

- walk backward from the current message;
- retain only the newest configured user/assistant history window;
- remove older mapping nodes before ChatGPT stores them;
- repair parent/child references inside the retained window.

## Your old messages are not deleted

ChatRAM changes what the **current browser tab loads**, not what is stored in your ChatGPT account.

If you need older history again:

1. Open ChatRAM.
2. Turn **Memory Saver** off.
3. Reload the ChatGPT tab.

ChatGPT can then load the conversation normally again.

When **Stop older pages loading** is enabled, you intentionally will not be able to scroll indefinitely into old history in that tab. That is the tradeoff that keeps the live conversation bounded.

## Memory measurements

The popup can capture a sample before ChatRAM reloads the page and another afterward. The browser decides which measurement API is available.

### Page memory

When Chrome allows `performance.measureUserAgentSpecificMemory()`, ChatRAM can use a broader page-memory estimate and show a real before/after comparison.

### JS heap only

On normal stable Chrome, ChatRAM often falls back to `performance.memory.usedJSHeapSize`.

That number is only V8's live JavaScript heap. It does **not** include every byte shown for the tab or renderer in Chrome Task Manager. It can also move up or down based on startup work and garbage-collection timing.

That is why ChatRAM labels this mode **JS heap only** instead of calling it total RAM.

Stable Chrome currently does not expose its exact Task Manager per-tab renderer memory to ordinary extensions. The `chrome.processes` API can expose process memory, but Chrome currently documents it as Dev-channel-only, so ChatRAM does not depend on it.

## Privacy

ChatRAM has:

- **no analytics**;
- **no telemetry**;
- **no account system**;
- **no external backend**;
- **no ads**;
- **no prompt or response collection**.

Conversation content is only touched inside the ChatGPT page so the history response can be reduced before ChatGPT consumes it. ChatRAM does not upload or persist the contents of your conversations.

The extension stores only local data needed for the extension itself, such as:

- your ChatRAM settings;
- non-content trim statistics such as `101 → 40`;
- local memory samples used by the popup.

## Permissions

ChatRAM intentionally keeps its permission surface small.

It requests:

- `storage` for settings, trim statistics, and local memory samples;
- host access to `chatgpt.com` and the legacy `chat.openai.com` domain so the interceptor can run on ChatGPT.

It does **not** request access to your browsing history, cookies, downloads, debugger, or the Dev-channel `processes` API.

## Known limitations

ChatRAM depends on internal ChatGPT web behavior. Those endpoints are not a public API and can change without notice.

Other things to know:

- changing the history window does not magically release memory already retained by the page; reload after changing it;
- branches, edits, or regeneration points outside the retained legacy window may require disabling ChatRAM and reloading;
- memory savings will vary dramatically between conversations;
- attachment-heavy or feature-heavy conversations can still use substantial memory even with old message history bounded;
- the built-in JS-heap meter is a diagnostic, not a replacement for Chrome Task Manager.

## Project structure

```text
src/main.js
  runs in ChatGPT's MAIN world at document_start
  wraps window.fetch
  identifies conversation-history requests
  limits and trims history before the app consumes it
  provides page/JS memory samples when requested

src/content.js
  runs in the extension's isolated world
  bridges settings to the MAIN-world interceptor
  relays memory samples back to the popup
  stores non-content trim statistics

src/popup.html
src/popup.css
src/popup.js
  Memory Saver controls
  history-window configuration
  memory diagnostics
  reload flow
  interception status
```

## Help test ChatRAM

The most useful contribution right now is real-world data from genuinely large conversations.

If you report a result, include:

```text
Browser/version:
Operating system:
History window:
Conversation size or age:
Before memory:
After memory:
Measurement source: Chrome Task Manager / Page memory / JS heap
Intercepted items: e.g. 101 → 40
Anything that broke:
```

Reproducible bugs and memory results are welcome through GitHub Issues.

## Status

ChatRAM is an early public project. The core approach is already producing meaningful reductions in real long-running ChatGPT conversations, but it still needs testing across more conversations, browser versions, and ChatGPT frontend changes.

## Disclaimer

ChatRAM is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI. ChatGPT is a trademark of OpenAI.

## Technical references

- [Chrome content scripts and `world: "MAIN"`](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [Chrome `processes` API](https://developer.chrome.com/docs/extensions/reference/api/processes)
- [MDN: `performance.memory`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory)
- [MDN: `measureUserAgentSpecificMemory()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)
