(() => {
  const defaults = {
    enabled: true,
    disableAnimations: true,
    reduceBlur: true,
    reduceShadows: false,
    instantScrolling: true,
    virtualizeMessages: true
  };

  const attributes = {
    enabled: "data-cgpt-speedup-enabled",
    disableAnimations: "data-cgpt-speedup-disable-animations",
    reduceBlur: "data-cgpt-speedup-reduce-blur",
    reduceShadows: "data-cgpt-speedup-reduce-shadows",
    instantScrolling: "data-cgpt-speedup-instant-scrolling",
    virtualizeMessages: "data-cgpt-speedup-virtualize-messages"
  };

  function apply(settings) {
    const root = document.documentElement;
    if (!root) return;

    for (const key of Object.keys(attributes)) {
      root.setAttribute(attributes[key], settings[key] ? "true" : "false");
    }
  }

  function refresh() {
    chrome.storage.sync.get(defaults, (settings) => {
      apply(settings || defaults);
    });
  }

  refresh();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (Object.keys(changes).some((key) => key in defaults)) refresh();
  });
})();
