# ChatGPT Speed-Up

A small Chromium Manifest V3 extension for the real long-chat performance problem: **conversation data and retained client state**, not cosmetic animations.

ChatGPT can become extremely memory-heavy after a long conversation has been loaded and older history has accumulated in the tab. This extension intercepts conversation-history reads before the ChatGPT app consumes them and limits how much history is allowed into the live client.

## What it does

### Current paginated ChatGPT format

As of August 2026, ChatGPT can load a conversation through:

```text
GET /backend-api/conversations/{id}?include_has_versions=true&num_turns=100
```

The response contains a `messages[]` array and `page_info`. Older history is requested with a `before` cursor.

When Memory Saver is enabled, the extension:

1. clamps `num_turns` to the configured history window when possible;
2. trims an oversized `messages[]` response before ChatGPT receives it;
3. sets `page_info.has_previous_page` to `false` when "Stop older pages loading" is enabled, preventing the app from continuously accumulating older pages in memory.

### Legacy ChatGPT format

Older ChatGPT builds/accounts used:

```text
GET /backend-api/conversation/{id}
```

with a complete `mapping` graph and `current_node`.

For that format, the extension walks backward from `current_node`, keeps only the newest configured user/assistant message window, removes unreachable mapping nodes, and repairs parent/child references before returning the response to ChatGPT.

## Important behavior

- **It does not delete conversation history.** Older messages remain stored by OpenAI.
- Disable Memory Saver and reload the ChatGPT tab to load the normal/full history again.
- If "Stop older pages loading" is enabled, scrolling to very old messages inside the current tab will intentionally stop at the retained window.
- Regeneration/edit branches outside the retained legacy window are not available until Memory Saver is disabled and the page is reloaded.
- ChatGPT uses internal, undocumented web endpoints. OpenAI can change them at any time, so this extension may need maintenance when the web app changes.
- No conversation content is uploaded anywhere by this extension. Settings and the last trim counts use Chrome extension storage only.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, Edge, Brave, Arc, or another Chromium browser.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Open a long ChatGPT conversation.
7. Use the extension popup to pick a history window, then click **Reload current tab**.

## Defaults

- Memory Saver: **on**
- Recent history window: **40**
- Stop older pages loading: **on**

The popup also shows the last intercepted response as `original → kept` so you can confirm that the extension actually caught the conversation load.

## Architecture

```text
src/main.js
  MAIN world, document_start
  wraps window.fetch
  identifies ChatGPT conversation-detail endpoints
  rewrites/clamps requests
  trims JSON responses before the application sees them

src/content.js
  isolated extension world
  bridges chrome.storage settings to the MAIN-world script
  stores non-content trim statistics for the popup

src/popup.html / popup.js / popup.css
  Memory Saver controls
  history-window selector
  reload button
  last-trim status
```

## Why not just delete DOM nodes?

Deleting old `<article>` elements can reduce rendered DOM size, but it does not guarantee that React, query caches, conversation objects, or other client state release the underlying history. ChatGPT can also recreate deleted DOM from its retained state. This extension attacks the problem earlier by reducing the conversation data before the app stores and renders it.

## References

- Chrome content scripts and `world: "MAIN"`: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- Observed August 2026 ChatGPT conversation pagination: https://gptspy.alinr.com/knowledge/endpoint/backend-api-conversations-id/
