(() => {
  const MEMORY_REQUEST = "chatram-memory-request";
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
  const beforeMemory = document.getElementById("beforeMemory");
  const nowMemory = document.getElementById("nowMemory");
  const memoryDelta = document.getElementById("memoryDelta");
  const memoryMethod = document.getElementById("memoryMethod");
  const memoryNote = document.getElementById("memoryNote");

  function setSaved(message) {
    saved.textContent = message;
    window.clearTimeout(setSaved.timer);
    setSaved.timer = window.setTimeout(() => {
      saved.textContent = "";
    }, 2200);
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

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";

    const gib = 1024 ** 3;
    const mib = 1024 ** 2;

    if (bytes >= gib) return `${(bytes / gib).toFixed(bytes >= 10 * gib ? 1 : 2)} GB`;
    return `${Math.max(0, bytes / mib).toFixed(bytes >= 100 * mib ? 0 : 1)} MB`;
  }

  function memoryCompatible(comparison, current, tabId) {
    const before = comparison?.before;
    return Boolean(
      before?.available &&
      current?.available &&
      comparison?.tabId === tabId &&
      before.pageKey === current.pageKey &&
      before.kind === current.kind
    );
  }

  function renderMemory(comparison, current, tabId) {
    const before = comparison?.before;
    const compatible = memoryCompatible(comparison, current, tabId);
    const method = current?.available ? current : before?.available ? before : null;
    const isPageMemory = method?.kind === "page-memory";
    const isJsHeap = method?.kind === "js-heap";

    beforeMemory.textContent = before?.available ? formatBytes(before.bytes) : "—";
    nowMemory.textContent = current?.available ? formatBytes(current.bytes) : "—";
    memoryMethod.textContent = isJsHeap ? "JS heap only" : method?.label || "Unavailable";
    memoryDelta.dataset.direction = "flat";

    if (isPageMemory && compatible) {
      const difference = before.bytes - current.bytes;
      const percent = before.bytes > 0 ? (Math.abs(difference) / before.bytes) * 100 : 0;

      if (difference > 0) {
        memoryDelta.textContent = `Saved ${formatBytes(difference)} (${percent.toFixed(0)}%)`;
        memoryDelta.dataset.direction = "down";
      } else if (difference < 0) {
        memoryDelta.textContent = `Up ${formatBytes(Math.abs(difference))} (${percent.toFixed(0)}%)`;
        memoryDelta.dataset.direction = "up";
      } else {
        memoryDelta.textContent = "No measurable change";
      }
    } else if (isJsHeap && compatible) {
      memoryDelta.textContent = "JS heap is not total tab RAM";
    } else if (before?.available && current?.available) {
      memoryDelta.textContent = "Open the same chat after reload to compare";
    } else {
      memoryDelta.textContent = "Reload through ChatRAM to capture Before";
    }

    if (isPageMemory) {
      memoryNote.textContent = "Chrome supplied a broader page-memory estimate, so Before/Now can be compared as a memory-saving result.";
    } else if (isJsHeap) {
      memoryNote.textContent = "This is only V8's live JavaScript heap. It can rise after reload because of startup and garbage-collection timing even when Chrome Task Manager RAM falls sharply.";
    } else {
      memoryNote.textContent = "Memory measurement is unavailable on this page/browser.";
    }
  }

  function requestTabMemory(tabId, callback) {
    chrome.tabs.sendMessage(tabId, { type: MEMORY_REQUEST }, (response) => {
      if (chrome.runtime.lastError || !response?.memory) {
        callback(null);
        return;
      }
      callback(response.memory);
    });
  }

  function loadMemoryComparison() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        renderMemory(null, null, null);
        return;
      }

      chrome.storage.local.get("memoryComparison", (result) => {
        const comparison = result?.memoryComparison || null;

        requestTabMemory(tab.id, (current) => {
          renderMemory(comparison, current, tab.id);

          if (memoryCompatible(comparison, current, tab.id)) {
            chrome.storage.local.set({
              memoryComparison: {
                ...comparison,
                after: current,
                measuredAt: Date.now()
              }
            });
          }
        });
      });
    });
  }

  chrome.storage.sync.get(DEFAULTS, (settings) => {
    writeForm(settings || DEFAULTS);
  });

  chrome.storage.local.get("lastTrimStats", (result) => {
    renderStats(result?.lastTrimStats);
  });

  loadMemoryComparison();

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
    reload.disabled = true;
    setSaved("Capturing Before memory…");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        reload.disabled = false;
        setSaved("Could not find the current tab.");
        return;
      }

      requestTabMemory(tab.id, (memory) => {
        const finishReload = () => {
          chrome.tabs.reload(tab.id, () => window.close());
        };

        if (!memory?.available) {
          finishReload();
          return;
        }

        chrome.storage.local.set(
          {
            memoryComparison: {
              tabId: tab.id,
              before: memory,
              after: null,
              capturedAt: Date.now()
            }
          },
          finishReload
        );
      });
    });
  });
})();
