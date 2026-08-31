(() => {
  const SOURCE = "chatgpt-speedup";
  const CACHE_KEY = "__chatgpt_speedup_settings_v1";
  const DEFAULTS = {
    enabled: true,
    historyLimit: 40,
    blockOlderPages: true
  };

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

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== SOURCE || event.data.type !== "stats") return;

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
  });
})();
