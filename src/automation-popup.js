(() => {
  "use strict";

  const PREFIX = "chatram:auto:";
  const DEFAULT_CONTINUE = "Continue working on the current task. Do not stop at a progress report. Verify what is actually finished, address remaining issues, and report any genuine blockers.";
  const $ = (id) => document.getElementById(id);
  const fields = {
    mode: $("autoMode"),
    marker: $("autoMarker"),
    criteria: $("autoCriteria"),
    continuePrompt: $("autoContinuePrompt"),
    oncePrompt: $("autoOncePrompt"),
    maxSends: $("autoMaxSends")
  };
  const start = $("armAutomation");
  const stop = $("stopAutomation");
  const status = $("automationStatus");
  const badge = $("automationBadge");
  let tabId = null;
  let busy = false;
  let currentRun = null;
  let draftTimer = null;

  function request(type, details = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: PREFIX + type, tabId, ...details }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || "Automation operation failed."));
        else resolve(response);
      });
    });
  }

  function config() {
    return {
      mode: fields.mode.value,
      marker: fields.marker.value.trim(),
      criteria: fields.criteria.value.trim(),
      continuePrompt: fields.continuePrompt.value.trim(),
      oncePrompt: fields.oncePrompt.value.trim(),
      maxSends: Number.parseInt(fields.maxSends.value, 10)
    };
  }

  function writeForm(value) {
    fields.mode.value = value?.mode === "once" ? "once" : "continue";
    fields.marker.value = value?.marker || "[[CHATRAM_COMPLETE]]";
    fields.criteria.value = value?.criteria || "";
    fields.continuePrompt.value = value?.continuePrompt || DEFAULT_CONTINUE;
    fields.oncePrompt.value = value?.oncePrompt || "";
    fields.maxSends.value = String(value?.maxSends || 10);
    if (!fields.maxSends.value) fields.maxSends.value = "10";
    updateVisibility();
  }

  function updateVisibility() {
    const continuing = fields.mode.value === "continue";
    $("continueFields").hidden = !continuing;
    $("onceFields").hidden = continuing;
  }

  function draftKey() {
    return "chatram:auto:draft:" + tabId;
  }

  function saveDraftSoon() {
    if (tabId == null) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      chrome.storage.session.set({ [draftKey()]: config() });
    }, 250);
  }

  function showState(state) {
    currentRun = state;
    const active = Boolean(state?.active);
    start.disabled = busy || tabId == null;
    stop.disabled = busy || !active;
    badge.textContent = active ? "Armed" : (state?.status === "completed" ? "Complete" : "Off");
    badge.dataset.active = active ? "true" : "false";

    let detail = "Not armed. Settings apply only to this tab.";
    switch (state?.status) {
      case "waiting": detail = "Armed. Waiting for the current or next assistant response to finish."; break;
      case "sending": detail = "Submitting the follow-up to ChatGPT…"; break;
      case "sent-once": detail = "One follow-up sent. Automation stopped."; break;
      case "completed": detail = "Completion marker detected. Automation stopped."; break;
      case "limit": detail = "Maximum follow-ups reached without the completion marker. Stopped."; break;
      case "changed-chat": detail = "Conversation changed in this tab. Automation stopped."; break;
      case "error": detail = "Paused: " + (state.error || "Unknown error"); break;
      case "stopped": detail = "Stopped for this tab."; break;
    }
    if (state?.mode === "continue" && state?.sendCount) {
      detail += " (" + state.sendCount + "/" + state.maxSends + " automatic follow-ups)";
    }
    status.textContent = detail;
    status.dataset.error = state?.status === "error" || state?.status === "limit" ? "true" : "false";
  }

  async function refresh() {
    if (tabId == null || busy) return;
    try {
      const result = await request("get");
      if (result.state?.runId !== currentRun?.runId || result.state?.status !== currentRun?.status || result.state?.sendCount !== currentRun?.sendCount) {
        showState(result.state);
      }
    } catch (error) {
      status.textContent = String(error?.message || error);
    }
  }

  function validChat(url) {
    try {
      const parsed = new URL(url);
      return ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) &&
        /^\/c\/[a-z0-9-]{12,100}\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function markerInstruction() {
    return [
      "When working on this task, continue until everything is implemented and checked against the requested requirements.",
      fields.criteria.value.trim() ? "Completion criteria:\n" + fields.criteria.value.trim() : "",
      "Only when the work is genuinely finished, put this exact marker on its own line in your final answer:",
      fields.marker.value.trim() || "[[CHATRAM_COMPLETE]]",
      "Never print that marker early or in a progress update. If blocked, explain what is blocked without printing it."
    ].filter(Boolean).join("\n\n");
  }

  for (const field of Object.values(fields)) {
    field.addEventListener("input", saveDraftSoon);
    field.addEventListener("change", () => {
      updateVisibility();
      saveDraftSoon();
    });
  }

  $("copyCompletionRule").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(markerInstruction());
      status.textContent = "Completion instruction copied. Include it in your task prompt.";
    } catch {
      status.textContent = "Clipboard permission denied.";
    }
  });

  start.addEventListener("click", async () => {
    if (tabId == null || busy) return;
    busy = true;
    start.disabled = true;
    stop.disabled = true;
    status.textContent = "Arming automation for this tab…";
    try {
      const result = await request("start", { config: config() });
      showState(result.state);
    } catch (error) {
      status.textContent = String(error?.message || error);
      status.dataset.error = "true";
    } finally {
      busy = false;
      start.disabled = false;
      stop.disabled = !currentRun?.active;
    }
  });

  stop.addEventListener("click", async () => {
    if (tabId == null || busy) return;
    busy = true;
    stop.disabled = true;
    try {
      const result = await request("stop");
      showState(result.state);
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      busy = false;
      start.disabled = false;
      stop.disabled = !currentRun?.active;
    }
  });

  writeForm(null);
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id || !validChat(tab.url)) {
      start.disabled = true;
      stop.disabled = true;
      badge.textContent = "Unavailable";
      status.textContent = "Open a saved ChatGPT conversation to use tab automation.";
      return;
    }
    tabId = tab.id;
    try {
      const saved = await chrome.storage.session.get(draftKey());
      const result = await request("get");
      writeForm(saved[draftKey()] || result.state);
      showState(result.state);
      window.setInterval(() => { void refresh(); }, 1800);
    } catch (error) {
      status.textContent = String(error?.message || error);
      start.disabled = true;
    }
  });
})();