(() => {
  const DEFAULTS = {
    enabled: true,
    historyLimit: 40,
    blockOlderPages: true
  };

  const enabled = document.getElementById("enabled");
  const historyLimit = document.getElementById("historyLimit");
  const blockOlderPages = document.getElementById("blockOlderPages");
  const stats = document.getElementById("stats");
  const saved = document.getElementById("saved");
  const reset = document.getElementById("reset");
  const reload = document.getElementById("reload");

  function setSaved(message) {
    saved.textContent = message;
    window.clearTimeout(setSaved.timer);
    setSaved.timer = window.setTimeout(() => {
      saved.textContent = "";
    }, 1800);
  }

  function readForm() {
    return {
      enabled: enabled.checked,
      historyLimit: Number.parseInt(historyLimit.value, 10) || DEFAULTS.historyLimit,
      blockOlderPages: blockOlderPages.checked
    };
  }

  function writeForm(settings) {
    enabled.checked = settings.enabled !== false;
    historyLimit.value = String(settings.historyLimit || DEFAULTS.historyLimit);
    blockOlderPages.checked = settings.blockOlderPages !== false;
  }

  function save() {
    chrome.storage.sync.set(readForm(), () => {
      setSaved("Saved. Reload to free existing memory.");
    });
  }

  function renderStats(value) {
    if (!value || !value.timestamp) {
      stats.textContent = "No conversation intercepted yet";
      return;
    }

    const original = Number(value.originalCount || 0);
    const kept = Number(value.keptCount || 0);
    const format = value.format === "legacy-mapping" ? "legacy graph" : "paginated history";

    stats.textContent = `${original} → ${kept} items (${format})`;
  }

  chrome.storage.sync.get(DEFAULTS, (settings) => {
    writeForm(settings || DEFAULTS);
  });

  chrome.storage.local.get("lastTrimStats", (result) => {
    renderStats(result?.lastTrimStats);
  });

  for (const control of [enabled, historyLimit, blockOlderPages]) {
    control.addEventListener("change", save);
  }

  reset.addEventListener("click", () => {
    writeForm(DEFAULTS);
    chrome.storage.sync.set(DEFAULTS, () => {
      setSaved("Defaults restored. Reload to apply.");
    });
  });

  reload.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        setSaved("Could not find the current tab.");
        return;
      }

      chrome.tabs.reload(tab.id, () => window.close());
    });
  });
})();
