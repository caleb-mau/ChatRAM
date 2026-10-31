(() => {
  "use strict";

  const core = window.ChatRAMPromptImprover;
  const $ = (id) => document.getElementById(id);
  const panel = $("improverPanel");
  const resultStatus = $("improverStatus");
  const target = $("improverTarget");
  const manual = $("improverManual");
  const STORAGE_PREFIX = "chatram:improve:";
  let tabId = null;
  let pending = null;
  let working = false;

  const fields = {
    autoCriteria: $("autoCriteria"),
    autoContinuePrompt: $("autoContinuePrompt"),
    autoOncePrompt: $("autoOncePrompt")
  };

  function config() {
    return {
      mode: $("autoMode").value,
      marker: $("autoMarker").value.trim(),
      criteria: $("autoCriteria").value.trim(),
      continuePrompt: $("autoContinuePrompt").value.trim(),
      oncePrompt: $("autoOncePrompt").value.trim(),
      maxSends: Number.parseInt($("autoMaxSends").value, 10) || 10
    };
  }

  function storageKey() {
    return STORAGE_PREFIX + tabId;
  }

  function setStatus(message, error = false) {
    resultStatus.textContent = String(message);
    resultStatus.dataset.error = error ? "true" : "false";
  }

  function showPending(value) {
    pending = value;
    panel.hidden = !value;
    if (!value) return;
    target.textContent = "Improving: " + (core.labels[value.field] || "Prompt");
    setStatus("Ready. Copy ChatGPT's finished response, return to this tab, then click Apply.");
  }

  function isEligible(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(u.hostname) &&
        /(?:^|\/)c\/[a-z0-9-]{12,100}\/?$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  async function begin(field) {
    if (working) return;
    if (!core.labels[field] || !fields[field]) return;
    const original = fields[field].value;
    let prepared;
    try {
      prepared = core.buildPrompt(field, original, config());
    } catch (error) {
      panel.hidden = false;
      target.textContent = "Improve prompt";
      setStatus(error.message, true);
      return;
    }

    working = true;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!Number.isInteger(tab?.id) || !isEligible(tab.url)) throw new Error("Return to the saved ChatGPT conversation tab to improve its prompts.");

      tabId = tab.id;
      const state = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "chatram:auto:get", tabId }, resolve);
      });
      if (state?.state?.active) throw new Error("Stop the armed automation before changing its prompts. The active run will not pick up changes.");

      // No ChatGPT session tokens, private API calls, or automatic answer capture.
      await navigator.clipboard.writeText(prepared);
      const record = {
        field, original, request: prepared, createdAt: Date.now(),
        sourceUrl: tab.url
      };
      await chrome.storage.session.set({ [storageKey()]: record });
      showPending(record);
      manual.value = "";
      await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    } catch (error) {
      panel.hidden = false;
      setStatus("Could not open the helper: " + String(error.message || error), true);
    } finally {
      working = false;
    }
  }

  async function clearPending() {
    if (tabId != null) await chrome.storage.session.remove(storageKey());
    showPending(null);
    manual.value = "";
  }

  async function applyImprovement(value) {
    if (working || !pending || !fields[pending.field]) return;
    const text = String(value || "").trim();
    const limit = core.maxInput[pending.field];
    if (!text) {
      setStatus("No improved text found. Copy ChatGPT's response first, or paste it manually below.", true);
      return;
    }
    if (text.length > limit) {
      setStatus("This response is " + text.length + " characters, but this setting only accepts " + limit + ". Ask ChatGPT to shorten it, then try again.", true);
      return;
    }
    const input = fields[pending.field];
    if (input.value !== pending.original) {
      setStatus("You changed the original prompt while the helper was open. Review both versions before applying to avoid overwriting newer edits.", true);
      manual.value = text;
      pending.original = input.value;
      return;
    }

    working = true;
    try {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Explicit immediate session save: the popup may close before its debounce runs.
      await chrome.storage.session.set({
        ["chatram:auto:draft:" + tabId]: config()
      });
      await clearPending();
      $("automationStatus").textContent = "Improved prompt applied and saved for this tab. Review it before arming.";
      input.focus();
    } catch (error) {
      setStatus("Could not save improved prompt: " + String(error.message || error), true);
    } finally {
      working = false;
    }
  }

  for (const button of document.querySelectorAll("[data-improve-field]")) {
    button.addEventListener("click", () => { void begin(button.dataset.improveField); });
  }

  $("improverCopyRequest").addEventListener("click", async () => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.request);
      setStatus("Improvement request copied again. Use it in the separate Temporary Chat.");
    } catch (error) {
      setStatus("Could not copy request: " + String(error.message || error), true);
    }
  });

  $("improverApplyClipboard").addEventListener("click", async () => {
    if (!pending) return;
    try {
      let permission = await chrome.permissions.contains({ permissions: ["clipboardRead"] });
      if (!permission) permission = await chrome.permissions.request({ permissions: ["clipboardRead"] });
      if (!permission) {
        setStatus("Clipboard access not granted. Paste the result manually below instead.", true);
        return;
      }
      const copied = await navigator.clipboard.readText();
      if (copied.trim() === pending.request.trim()) {
        setStatus("Your clipboard still contains the improvement request. Copy ChatGPT's response before applying.", true);
        return;
      }
      await applyImprovement(copied);
    } catch (error) {
      setStatus("Cannot read clipboard: " + String(error.message || error) + ". Paste manually instead.", true);
    }
  });

  $("improverApplyManual").addEventListener("click", () => {
    void applyImprovement(manual.value);
  });

  $("improverCancel").addEventListener("click", () => { void clearPending(); });

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs?.[0];
    if (!Number.isInteger(tab?.id) || !isEligible(tab.url)) return;
    tabId = tab.id;
    try {
      const saved = await chrome.storage.session.get(storageKey());
      const record = saved[storageKey()];
      if (record && record.sourceUrl === tab.url && core.labels[record.field]) {
        showPending(record);
      } else if (record) {
        await chrome.storage.session.remove(storageKey());
      }
    } catch (error) {
      setStatus("Could not recover pending improvement: " + String(error.message || error), true);
    }
  });
})();
