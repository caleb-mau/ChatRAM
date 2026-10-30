(() => {
  const SOURCE = "chatgpt-speedup";
  const CACHE_KEY = "__chatgpt_speedup_settings_v1";
  const MEMORY_REQUEST = "chatram-memory-request";
  const HANDOFF_REQUEST = "chatram-handoff-request";
  const DEFAULTS = {
    enabled: true,
    historyLimit: 40,
    blockOlderPages: true
  };

  const pendingMemoryRequests = new Map();
  const pendingHandoffRequests = new Map();

  function normalizeSettings(value) {
    const raw = value && typeof value === "object" ? value : {};
    const parsedLimit = Number.parseInt(raw.historyLimit, 10);

    return {
      enabled: raw.enabled !== false,
      historyLimit: Number.isFinite(parsedLimit)
        ? Math.min(200, Math.max(10, parsedLimit))
        : DEFAULTS.historyLimit,
      blockOlderPages: raw.blockOlderPages !== false
    };
  }

  function publish(settings) {
    const normalized = normalizeSettings(settings);

    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(normalized));
    } catch {
      // The MAIN-world script also has defaults, so storage failure is non-fatal.
    }

    window.postMessage(
      {
        source: SOURCE,
        type: "settings",
        settings: normalized
      },
      "*"
    );
  }

  function memoryRequestId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function requestPageMemory(sendResponse) {
    const requestId = memoryRequestId();
    const timer = window.setTimeout(() => {
      const pending = pendingMemoryRequests.get(requestId);
      if (!pending) return;
      pendingMemoryRequests.delete(requestId);
      pending.sendResponse({ ok: false, error: "Memory measurement timed out." });
    }, 7000);

    pendingMemoryRequests.set(requestId, { sendResponse, timer });
    window.postMessage(
      {
        source: SOURCE,
        type: "memory-request",
        requestId
      },
      "*"
    );
  }

  function requestHandoff(sendResponse) {
    const requestId = memoryRequestId();
    const timer = window.setTimeout(() => {
      const pending = pendingHandoffRequests.get(requestId);
      if (!pending) return;
      pendingHandoffRequests.delete(requestId);
      pending.sendResponse({ ok: false, error: "Chat history retrieval timed out." });
    }, 120000);

    pendingHandoffRequests.set(requestId, { sendResponse, timer });
    window.postMessage({ source: SOURCE, type: "handoff-request", requestId }, window.location.origin);
  }

  chrome.storage.sync.get(DEFAULTS, (settings) => {
    publish(settings || DEFAULTS);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!Object.keys(changes).some((key) => key in DEFAULTS)) return;

    chrome.storage.sync.get(DEFAULTS, (settings) => {
      publish(settings || DEFAULTS);
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MEMORY_REQUEST) {
      requestPageMemory(sendResponse);
      return true;
    }
    if (message?.type === HANDOFF_REQUEST) {
      requestHandoff(sendResponse);
      return true;
    }
    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== SOURCE) return;

    if (event.data.type === "handoff-response") {
      const requestId = String(event.data.requestId || "");
      const pending = pendingHandoffRequests.get(requestId);
      if (!pending) return;

      window.clearTimeout(pending.timer);
      pendingHandoffRequests.delete(requestId);
      pending.sendResponse(
        event.data.error
          ? { ok: false, error: String(event.data.error) }
          : { ok: true, handoff: event.data.handoff }
      );
      return;
    }

    if (event.data.type === "stats") {
      const stats = event.data.stats;
      if (!stats || typeof stats !== "object") return;

      chrome.storage.local.set({
        lastTrimStats: {
          format: String(stats.format || "unknown"),
          originalCount: Number(stats.originalCount || 0),
          keptCount: Number(stats.keptCount || 0),
          historyLimit: Number(stats.historyLimit || DEFAULTS.historyLimit),
          blockedOlderPages: Boolean(stats.blockedOlderPages),
          olderPageRequest: Boolean(stats.olderPageRequest),
          timestamp: Number(stats.timestamp || Date.now())
        }
      });
      return;
    }

    if (event.data.type === "memory-response") {
      const requestId = String(event.data.requestId || "");
      const pending = pendingMemoryRequests.get(requestId);
      if (!pending) return;

      window.clearTimeout(pending.timer);
      pendingMemoryRequests.delete(requestId);

      const raw = event.data.memory;
      const memory = {
        available: Boolean(raw?.available),
        bytes: Number.isFinite(raw?.bytes) ? raw.bytes : null,
        totalBytes: Number.isFinite(raw?.totalBytes) ? raw.totalBytes : null,
        limitBytes: Number.isFinite(raw?.limitBytes) ? raw.limitBytes : null,
        kind: String(raw?.kind || "unavailable"),
        label: String(raw?.label || "Unavailable"),
        timestamp: Number(raw?.timestamp || Date.now()),
        pageKey: window.location.pathname
      };

      chrome.storage.local.set({ lastMemorySample: memory });
      pending.sendResponse({ ok: memory.available, memory });
    }
  });
})();
