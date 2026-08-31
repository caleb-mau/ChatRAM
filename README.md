# ChatRAM

**Memory Saver for ChatGPT.**

ChatRAM is a small Chromium extension that keeps very long ChatGPT conversations from consuming several gigabytes of browser memory.

Instead of hiding DOM elements after ChatGPT has already loaded the conversation, ChatRAM limits how much conversation history reaches the live ChatGPT client in the first place.

## Measured result

In one real Google Chrome test with a very long conversation:

**4.5 GB → about 1.0 GB RAM**

That is a measured example, not a guaranteed result. Memory savings depend on the conversation, message sizes, browser version, and selected history window.

## Built-in memory comparison

ChatRAM can now capture the ChatGPT page's memory immediately before it reloads and show the current value afterward:

```text
Before     4.12 GB
Now        0.94 GB
Saved      3.18 GB (77%)
```

The exact measurement source depends on what the browser exposes:

- when available, ChatRAM uses `performance.measureUserAgentSpecificMemory()` for a broader page-memory estimate;
- otherwise Chromium falls back to `performance.memory.usedJSHeapSize`, which measures the live JavaScript heap.

Stable Chrome does **not** expose its Task Manager per-tab/renderer RAM total to ordinary extensions. Chrome's `chrome.processes` API can expose renderer private memory, but it is currently Dev-channel-only. Because of that, ChatRAM labels its measurement method instead of pretending the JS heap is the complete Task Manager RAM value.

The Before value is captured only when you click **Reload current tab** in ChatRAM. The comparison is tied to the same browser tab and conversation path so it will not compare two different chats by accident.

## How it works

ChatRAM runs before the ChatGPT application consumes conversation-history responses.

For the current paginated conversation format it can:

- clamp the requested recent-history window;
- trim oversized `messages[]` responses;
- stop older history pages from automatically accumulating in memory.

For the older ChatGPT conversation format it can:

- walk backward from the current message;
- keep only the newest configured user/assistant history window;
- remove older mapping nodes from the response before ChatGPT stores them.

This targets the actual retained conversation data rather than animations, blur effects, or cosmetic rendering work.

## Important behavior

- **ChatRAM does not delete your conversation history.**
- Older messages remain stored by ChatGPT/OpenAI.
- Disable Memory Saver and reload the tab to allow normal/full history loading again.
- With older-page loading blocked, you intentionally cannot scroll indefinitely into old history in that tab.
- Changing the history limit does not release memory already held by the page. Reload the tab after changing it.
- ChatGPT uses internal web endpoints that can change without notice, so ChatRAM may occasionally need updates.

## Defaults

- Memory Saver: **on**
- Recent history window: **40**
- Stop older pages loading: **on**

The popup shows both the memory comparison and the most recent intercepted history response as `original → kept` so you can verify that ChatRAM caught the conversation load.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Open a long ChatGPT conversation.
7. Open ChatRAM and click **Reload current tab**.
8. Open ChatRAM again after the conversation loads to see Before, Now, and the measured reduction.

It should also work in Chromium-based browsers such as Edge, Brave, and Arc, although Chrome is the primary target.

## Privacy

ChatRAM has no analytics, telemetry, accounts, or external service.

Conversation content is processed only inside the ChatGPT page so the response can be reduced before the web app consumes it. ChatRAM does not upload or persist prompts or responses.

The extension stores only:

- its settings;
- non-content trim statistics such as `100 → 40`;
- local before/after memory samples used by the popup.

## Permissions

ChatRAM requests:

- `storage` for settings, trim statistics, and local memory comparison values;
- host access only to `chatgpt.com` and the legacy `chat.openai.com` domain so it can run the memory-saving interceptor and read the page's own memory measurement.

It does not request Chrome's `debugger`, browsing-history, cookies, or Dev-channel `processes` permissions.

## Architecture

```text
src/main.js
  MAIN world, document_start
  wraps window.fetch
  identifies ChatGPT conversation-history endpoints
  limits requests and trims JSON before the app consumes it
  reads page/JS memory when the popup requests a sample

src/content.js
  isolated extension world
  bridges extension settings to the MAIN-world interceptor
  relays memory samples to the extension popup
  stores non-content trim statistics

src/popup.html / popup.js / popup.css
  Memory Saver controls
  before/now memory comparison
  history-window selector
  reload button
  last-trim status
```

## Why not just remove old DOM nodes?

Removing rendered message elements can reduce DOM size, but React and other client caches may still retain the underlying conversation data and recreate those elements later.

ChatRAM reduces the data before ChatGPT puts it into that live client state. A page reload then clears the already-retained JavaScript heap and reloads only the bounded history window.

## Status

ChatRAM is currently an early public build. The core approach has produced a measured reduction from roughly 4.5 GB to 1.0 GB on a large real-world conversation, but more conversations and browser versions still need testing.

Bug reports and reproducible memory measurements are welcome through GitHub Issues.

## Disclaimer

ChatRAM is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI. ChatGPT is a trademark of OpenAI.

## References

- Chrome content scripts and `world: "MAIN"`: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- Chrome `processes` API (Dev channel): https://developer.chrome.com/docs/extensions/reference/api/processes
- MDN `performance.memory`: https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory
- MDN `measureUserAgentSpecificMemory()`: https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
- Observed August 2026 ChatGPT conversation pagination: https://gptspy.alinr.com/knowledge/endpoint/backend-api-conversations-id/
