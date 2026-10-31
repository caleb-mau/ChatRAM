(() => {
  "use strict";

  const PREFIX = "chatram:auto:";
  const MAX_PROMPT = 4000;
  const DEFAULT_CONTINUE = "Continue working on the current task. Do not stop at a progress report. Verify what is actually finished, address remaining issues, and report any genuine blockers.";
  const locks = new Map();

  function key(tabId) {
    return PREFIX + tabId;
  }

  function normalizeConfig(raw) {
    const mode = raw?.mode === "continue" ? "continue" : raw?.mode === "once" ? "once" : null;
    const marker = String(raw?.marker || "[[CHATRAM_COMPLETE]]").trim();
    if (!mode) throw new Error("Choose an automation mode.");
    if (!/^[^\r\n]{4,80}$/.test(marker)) throw new Error("Use a completion marker between 4 and 80 characters on one line.");

    const oncePrompt = String(raw?.oncePrompt || "").trim().slice(0, MAX_PROMPT);
    if (mode === "once" && !oncePrompt) throw new Error("Enter the prompt to send once the current response is done.");

    return {
      mode,
      marker,
      criteria: String(raw?.criteria || "").trim().slice(0, 1500),
      continuePrompt: String(raw?.continuePrompt || DEFAULT_CONTINUE).trim().slice(0, MAX_PROMPT),
      oncePrompt,
      maxSends: Math.max(1, Math.min(25, Number.parseInt(raw?.maxSends, 10) || 10))
    };
  }

  function validConversationUrl(value) {
    try {
      const url = new URL(value);
      if (!["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return null;
      if (url.protocol !== "https:") return null;
      if (!/^\/c\/[a-z0-9-]{12,100}\/?$/i.test(url.pathname)) return null;
      return url.pathname.replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  async function read(tabId) {
    const result = await chrome.storage.session.get(key(tabId));
    return result[key(tabId)] || null;
  }

  async function write(tabId, value) {
    await chrome.storage.session.set({ [key(tabId)]: value });
    return value;
  }

  function serialized(tabId, callback) {
    const previous = locks.get(tabId) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    locks.set(tabId, current);
    void current.finally(() => {
      if (locks.get(tabId) === current) locks.delete(tabId);
    }).catch(() => {});
    return current;
  }

  async function update(tabId, request, action) {
    return serialized(tabId, async () => {
      const state = await read(tabId);
      if (!state || state.runId !== request.runId) return { ok: false, reason: "stale-run" };

      if (action === "stop") {
        if (!state.active) return { ok: true, state };
        return { ok: true, state: await write(tabId, { ...state, active: false, status: request.status === "completed" ? "completed" : request.status === "limit" ? "limit" : request.status === "changed-chat" ? "changed-chat" : "stopped", updatedAt: Date.now() }) };
      }
      if (action === "claim") {
        if (!state.active || state.status !== "waiting" || !request.fingerprint || state.lastHandled === request.fingerprint) {
          return { ok: false, reason: "not-available" };
        }
        return { ok: true, state: await write(tabId, { ...state, status: "sending", lastHandled: request.fingerprint, updatedAt: Date.now() }) };
      }
      if (action === "sent") {
        if (!state.active || state.status !== "sending" || state.lastHandled !== request.fingerprint) {
          return { ok: false, reason: "stale-send" };
        }
        return { ok: true, state: await write(tabId, { ...state, sendCount: state.sendCount + 1, status: state.mode === "once" ? "sent-once" : "waiting", active: state.mode !== "once", updatedAt: Date.now() }) };
      }
      if (action === "error") {
        if (!state.active) return { ok: true, state };
        return { ok: true, state: await write(tabId, { ...state, active: false, status: "error", error: String(request.error || "Unable to send the prompt.").slice(0, 300), updatedAt: Date.now() }) };
      }
      return { ok: false, reason: "unknown-action" };
    });
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove([key(tabId), "chatram:auto:draft:" + tabId]);
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.type !== "string" || !request.type.startsWith(PREFIX)) return false;

    const isContentScript = Number.isInteger(sender.tab?.id);
    const tabId = isContentScript ? sender.tab.id : request.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ ok: false, error: "No valid ChatGPT tab." });
      return false;
    }
    // A content script can only operate on its own tab.
    if (isContentScript && request.tabId != null && request.tabId !== tabId) {
      sendResponse({ ok: false, error: "Tab mismatch." });
      return false;
    }

    const handle = async () => {
      switch (request.type) {
        case PREFIX + "get":
          return { ok: true, state: await read(tabId) };
        case PREFIX + "start": {
          if (isContentScript) throw new Error("Start automation from ChatRAM's popup.");
          const tab = await chrome.tabs.get(tabId);
          const conversationPath = validConversationUrl(tab.url);
          if (!conversationPath) throw new Error("Open a saved ChatGPT conversation in this tab.");
          const config = normalizeConfig(request.config);
          const state = await serialized(tabId, () => write(tabId, {
            ...config, conversationPath, active: true, status: "waiting", sendCount: 0,
            runId: crypto.randomUUID(), lastHandled: null, error: "", updatedAt: Date.now()
          }));
          try { await chrome.tabs.sendMessage(tabId, { type: PREFIX + "wake", state }); } catch {
            await update(tabId, { runId: state.runId, error: "ChatRAM is not loaded on this tab. Reload ChatGPT and arm again." }, "error");
            throw new Error("Reload the ChatGPT tab to load the updated extension, then try again.");
          }
          return { ok: true, state };
        }
        case PREFIX + "stop":
          if (isContentScript) return update(tabId, request, "stop");
          return serialized(tabId, async () => {
            const previous = await read(tabId);
            if (!previous) return { ok: true, state: null };
            const state = await write(tabId, { ...previous, active: false, status: "stopped", updatedAt: Date.now() });
            try { await chrome.tabs.sendMessage(tabId, { type: PREFIX + "wake", state }); } catch {}
            return { ok: true, state };
          });
        case PREFIX + "claim":
        case PREFIX + "sent":
        case PREFIX + "error":
          if (!isContentScript) throw new Error("Automation progress must come from the ChatGPT tab.");
          return update(tabId, request, request.type.slice(PREFIX.length));
        default:
          return { ok: false, error: "Unknown automation action." };
      }
    };
    void handle().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });
})();