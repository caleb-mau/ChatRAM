(() => {
  "use strict";

  const PREFIX = "chatram:auto:";
  const QUIET_MS = 2600;
  const POLL_MS = 1200;
  let state = null;
  let baseline = null;
  let seenGenerating = false;
  let candidate = "";
  let candidateSince = 0;
  let checking = false;

  function request(type, details = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: PREFIX + type, ...details }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || response?.reason || "Automation request failed."));
        else resolve(response);
      });
    });
  }

  function currentConversationPath() {
    const match = window.location.pathname.match(/^\/c\/[a-z0-9-]{12,100}\/?$/i);
    return match ? window.location.pathname.replace(/\/$/, "") : null;
  }

  function isVisible(element) {
    return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  }

  function isGenerating() {
    return [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop response"]'
    ].some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
  }

  function lastAssistant() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    const body = node.querySelector(".markdown, [class*='markdown'], .prose") || node;
    const text = (body.innerText || body.textContent || "").trim();
    if (!text) return null;

    const container = node.closest("[data-message-id], [data-testid^='conversation-turn-']") || node;
    const id = container.getAttribute("data-message-id") || container.getAttribute("data-testid") || "";
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return {
      text,
      fingerprint: [nodes.length, id, text.length, (hash >>> 0).toString(16)].join(":")
    };
  }

  function exactCompletion(text, marker) {
    let fenced = false;
    for (const line of text.replace(/\r/g, "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(String.fromCharCode(96).repeat(3)) || trimmed.startsWith("~~~")) {
        fenced = !fenced;
        continue;
      }
      if (!fenced && trimmed === marker) return true;
    }
    return false;
  }

  function composer() {
    return document.querySelector(
      '#prompt-textarea[contenteditable="true"], #prompt-textarea textarea, textarea#prompt-textarea, [data-testid="composer-text-input"][contenteditable="true"]'
    );
  }

  function draftText(input) {
    return (input?.value != null ? input.value : input?.innerText || input?.textContent || "").trim();
  }

  function sendButton() {
    for (const selector of [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]'
    ]) {
      const button = [...document.querySelectorAll(selector)].find(isVisible);
      if (button) return button;
    }
    return null;
  }

  async function sendPrompt(prompt, runId) {
    const input = composer();
    if (!input || !isVisible(input)) throw new Error("ChatGPT's composer was not found. Automation stopped safely.");
    if (draftText(input)) throw new Error("A draft is already in the composer. Automation paused to avoid overwriting it.");
    if (isGenerating()) throw new Error("ChatGPT started generating again before the follow-up could be sent.");

    input.focus();
    let injected = false;

    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("Could not access the prompt input.");
      setter.call(input, prompt);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      injected = input.value === prompt;
    } else {
      injected = document.execCommand("insertText", false, prompt);
      injected = Boolean(injected && draftText(input).includes(prompt));
    }

    if (!injected) throw new Error("ChatGPT rejected prompt insertion. Automation stopped without submitting.");

    for (let retry = 0; retry < 8; retry++) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const button = sendButton();
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
        const latest = await request("get");
        if (!latest.state?.active || latest.state.runId !== runId || latest.state.status !== "sending" ||
            currentConversationPath() !== latest.state.conversationPath) {
          throw new Error("Automation stopped or the conversation changed before submission. Unsent draft was preserved.");
        }
        button.click();
        // Do not mark a message as submitted until ChatGPT clears the editor.
        for (let check = 0; check < 12; check++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const updated = composer();
          if (updated && !draftText(updated)) return;
        }
        throw new Error("Send was clicked but ChatGPT did not clear the editor. Automation paused to avoid a duplicate.");
      }
    }
    throw new Error("ChatGPT's Send button did not become available. Review the unsent draft before retrying.");
  }

  function continueText() {
    const reminder = [
      "Completion protocol for this chat:",
      "Only after ALL requested work is actually complete and verified to the requested standard,",
      "end your visible final answer with the following exact standalone line:",
      state.marker,
      "Do not use that marker in a progress update. Be accurate about blockers and work not verified."
    ].join("\n");
    return [
      state.continuePrompt,
      state.criteria ? "Required completion criteria:\n" + state.criteria : "",
      reminder
    ].filter(Boolean).join("\n\n");
  }

  function arm(nextState) {
    state = nextState;
    baseline = lastAssistant()?.fingerprint || null;
    seenGenerating = isGenerating();
    candidate = "";
    candidateSince = 0;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== PREFIX + "wake") return false;
    if (message.state?.active) arm(message.state);
    else {
      state = null;
      baseline = null;
    }
    return false;
  });

  async function tick() {
    if (!state?.active || checking) return;
    const runId = state.runId;
    checking = true;
    try {
      if (currentConversationPath() !== state.conversationPath) {
        await request("stop", { runId, status: "changed-chat" });
        state = null;
        return;
      }
      if (isGenerating()) {
        seenGenerating = true;
        candidate = "";
        candidateSince = 0;
        return;
      }

      const reply = lastAssistant();
      if (!reply) return;
      if (!seenGenerating && reply.fingerprint === baseline) return;
      if (reply.fingerprint === state.lastHandled) return;

      if (reply.fingerprint !== candidate) {
        candidate = reply.fingerprint;
        candidateSince = Date.now();
        return;
      }
      if (Date.now() - candidateSince < QUIET_MS) return;

      if (state.mode === "continue" && exactCompletion(reply.text, state.marker)) {
        await request("stop", { runId, status: "completed" });
        state = null;
        return;
      }
      if (state.mode === "continue" && state.sendCount >= state.maxSends) {
        await request("stop", { runId, status: "limit" });
        state = null;
        return;
      }

      const fingerprint = reply.fingerprint;
      const claim = await request("claim", { runId, fingerprint });
      if (!claim.state?.active) return;
      state = claim.state;
      const prompt = state.mode === "once" ? state.oncePrompt : continueText();

      if (currentConversationPath() !== state.conversationPath) throw new Error("The selected conversation changed.");
      const confirmation = await request("get");
      if (!confirmation.state?.active || confirmation.state.runId !== runId || confirmation.state.status !== "sending") return;

      await sendPrompt(prompt, runId);
      const result = await request("sent", { runId, fingerprint });
      state = result.state;
      baseline = fingerprint;
      seenGenerating = false;
      candidate = "";
      candidateSince = 0;
    } catch (error) {
      try { await request("error", { runId, error: String(error?.message || error) }); } catch {}
      state = null;
    } finally {
      checking = false;
    }
  }

  void request("get").then((result) => {
    if (result.state?.active) {
      if (result.state.status === "sending") {
        void request("error", { runId: result.state.runId, error: "A page reload interrupted sending. Re-arm to prevent a duplicate." });
      } else arm(result.state);
    }
  }).catch(() => {});

  window.setInterval(() => { void tick(); }, POLL_MS);
})();