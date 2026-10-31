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

## Continue a chat after its limit

ChatRAM **v0.5.0** adds a **Conversation handoff** section in the popup. This is available whenever a saved ChatGPT conversation is open, including when the chat no longer accepts new messages.

1. Open the long conversation in ChatGPT and open the ChatRAM extension popup.
2. Click **Prepare handoff**. ChatRAM fetches older history directly from ChatGPT in small pages, bypassing the extension's own recent-history window.
3. Click **Copy continuation context**, open a new ChatGPT conversation, and paste it.
4. For an audit trail, use **Copy full text** or **Download .md**. Very large transcripts must be downloaded instead of copied in one operation.

**Continuation context** is a locally assembled, paste-size-limited excerpt of the conversation. For long chats it prioritizes the initial project description, recent working state, and explicit user instructions from throughout the conversation. It reports when messages were omitted. **It is not an AI-written summary**, and it cannot guarantee every decision was included.

**Full text** attempts to retrieve all readable user/assistant text on the selected conversation path. It has a safety limit of 30,000 messages, 500 pages, or 12 million characters, whichever comes first. If pagination fails or a safety limit is reached, ChatRAM explicitly marks the capture incomplete.

Images, file attachment contents, complete tool internals, and private model reasoning are not exported. This tool cannot transfer the underlying model's hidden state or automatically provide an exact amount of remaining context. If a conversation becomes too long, prepare the handoff from the popup. You do not need to ask the old conversation for another response.

ChatRAM makes read-only requests to ChatGPT while you're signed in. It uses your existing authenticated tab, performs no third-party transmission, and does not persist the captured conversation content to extension storage. The text stays in volatile extension memory until the popup is closed, unless you explicitly copy or download it.

## Per-tab follow-up automation (v0.6.0)

The popup now offers two **opt-in, tab-specific** behaviors. They are off by default, stored only for the browser session, and do not run in other ChatGPT tabs.

- **Continue until complete:** Arm it while ChatGPT is responding, or before sending your next task. Once the current response finishes, ChatRAM looks for an exact standalone completion marker in the last visible assistant response, by default `[[CHATRAM_COMPLETE]]`. If absent, ChatRAM sends a configurable continuation prompt, reminding ChatGPT about the completion standards and marker. It repeats until the marker appears or the user-configured follow-up cap is reached (10 by default, 25 maximum).
- **Send once done:** Enter the next prompt, then arm the tab. ChatRAM waits for a newly completed response, submits exactly one follow-up, and stops.

**How to use continue mode:** Click **Copy marker instruction** and add it to your original task. Tell ChatGPT exactly what counts as complete in **Completion standards**. The extension cannot independently verify source code, tests, files, or deployment quality: it trusts the exact marker from the model and does not treat a general phrase like "done" as proof. The marker must be a standalone line, outside a code fence.

**Safeguards:** Each tab and conversation is independent. Automation never sends immediately on an old response; it waits for the current in-progress or next answer, then for a quiet interval after generation stops. It stops when the tab navigates to a different conversation, when the required composer cannot be found, when a draft exists, when insertion fails, when the user presses Stop, or when the follow-up limit is reached. Each reply can trigger at most one automatic send; submission claims are saved before clicking Send to avoid duplicates after a reload. Progress and current status appear in the extension popup.

Chrome background-tab throttling, ChatGPT UI changes, model limits, network failures and site restrictions can interrupt automation. ChatRAM does not bypass ChatGPT limits, automatically confirm actual task completion, or keep a discarded/sleeping tab alive. Do not use unattended automation for high-impact actions without reviewing what it is doing.

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
- **no background prompt or response collection unless you explicitly arm follow-up automation** (the opt-in handoff temporarily reads conversation text without saving it to extension storage).

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
src/automation-background.js
  tracks per-tab mode, progress, completion state, and send guards in session storage

src/automation-content.js
  watches the active conversation and sends explicitly configured follow-ups

src/automation-popup.js
  tab-only follow-up settings and controls

src/handoff-main.js
  fetches the full conversation only when the user requests a handoff
  follows ChatGPT's history pages without the Memory Saver cap
  returns visible user/assistant text to the popup

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
src/handoff-popup.js
  Memory Saver controls
  history-window configuration
  memory diagnostics
  reload flow
  interception status
  copy-paste continuation context and full-text transcript export
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
