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

  function readCachedSettings() {
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      return cached ? normalizeSettings(JSON.parse(cached)) : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  let settings = readCachedSettings();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== SOURCE || event.data.type !== "settings") return;

    settings = normalizeSettings(event.data.settings);

    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch {
      // Settings still apply for this page even if site storage is unavailable.
    }
  });

  function emitStats(stats) {
    window.postMessage(
      {
        source: SOURCE,
        type: "stats",
        stats: {
          ...stats,
          timestamp: Date.now()
        }
      },
      "*"
    );
  }

  function requestMethod(input, init) {
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    return String(method).toUpperCase();
  }

  function requestUrl(input) {
    try {
      if (input instanceof Request) return new URL(input.url);
      return new URL(String(input), window.location.href);
    } catch {
      return null;
    }
  }

  function endpointType(url) {
    if (!url || url.origin !== window.location.origin) return null;

    if (/^\/backend-api\/conversations\/[^/]+\/?$/.test(url.pathname)) {
      return "paginated";
    }

    if (/^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname)) {
      return "legacy";
    }

    return null;
  }

  function clampPaginatedRequest(input, url) {
    const current = Number.parseInt(url.searchParams.get("num_turns") || "", 10);
    if (Number.isFinite(current) && current <= settings.historyLimit) return input;

    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set("num_turns", String(settings.historyLimit));

    if (typeof input === "string") return nextUrl.toString();
    if (input instanceof URL) return nextUrl;

    // A Request object's URL is immutable. The response will still be trimmed,
    // but we avoid rebuilding the request and accidentally changing its semantics.
    return input;
  }

  function roleOf(node) {
    return node?.message?.author?.role || node?.message?.role || node?.author?.role || node?.role || null;
  }

  function trimLegacyConversation(data) {
    if (!data || typeof data.mapping !== "object" || !data.mapping || !data.current_node) {
      return null;
    }

    const mapping = data.mapping;
    const keep = new Set();
    let cursor = data.current_node;
    let visibleMessages = 0;
    let guard = 0;

    while (cursor && mapping[cursor] && guard < 10000) {
      const node = mapping[cursor];
      keep.add(cursor);

      const role = roleOf(node);
      if (role === "user" || role === "assistant") visibleMessages += 1;

      if (visibleMessages >= settings.historyLimit) break;
      cursor = node.parent;
      guard += 1;
    }

    if (keep.size === 0) return null;

    const originalCount = Object.keys(mapping).length;
    const trimmed = {};

    for (const id of keep) {
      const node = mapping[id];
      trimmed[id] = {
        ...node,
        parent: node.parent && keep.has(node.parent) ? node.parent : null,
        children: Array.isArray(node.children)
          ? node.children.filter((childId) => keep.has(childId))
          : node.children
      };
    }

    data.mapping = trimmed;

    return {
      format: "legacy-mapping",
      originalCount,
      keptCount: keep.size,
      historyLimit: settings.historyLimit,
      blockedOlderPages: false
    };
  }

  function trimPaginatedConversation(data, url) {
    if (!data || !Array.isArray(data.messages)) return null;

    const originalCount = data.messages.length;
    const isOlderPage = url.searchParams.has("before");

    if (data.messages.length > settings.historyLimit) {
      data.messages = data.messages.slice(-settings.historyLimit);
    }

    if (settings.blockOlderPages && data.page_info && typeof data.page_info === "object") {
      data.page_info = {
        ...data.page_info,
        has_previous_page: false
      };
    }

    return {
      format: "paginated-messages",
      originalCount,
      keptCount: data.messages.length,
      historyLimit: settings.historyLimit,
      blockedOlderPages: settings.blockOlderPages,
      olderPageRequest: isOlderPage
    };
  }

  function rebuildJsonResponse(response, body) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("content-type", "application/json");

    const rebuilt = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });

    // Preserve commonly inspected response metadata when the browser allows it.
    for (const property of ["url", "redirected", "type"]) {
      try {
        Object.defineProperty(rebuilt, property, {
          configurable: true,
          value: response[property]
        });
      } catch {
        // These fields are advisory for this endpoint; JSON consumers still work.
      }
    }

    return rebuilt;
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function chatGptSpeedUpFetch(input, init) {
    if (!settings.enabled || requestMethod(input, init) !== "GET") {
      return nativeFetch(input, init);
    }

    const originalUrl = requestUrl(input);
    const type = endpointType(originalUrl);

    if (!type) return nativeFetch(input, init);

    let requestInput = input;
    if (type === "paginated") {
      requestInput = clampPaginatedRequest(input, originalUrl);
    }

    const response = await nativeFetch(requestInput, init);
    if (!response.ok) return response;

    let bodyText;
    let data;

    try {
      bodyText = await response.text();
      data = JSON.parse(bodyText);
      bodyText = null;
    } catch {
      if (typeof bodyText === "string") return rebuildJsonResponse(response, bodyText);
      return response;
    }

    const stats =
      type === "paginated"
        ? trimPaginatedConversation(data, originalUrl)
        : trimLegacyConversation(data);

    if (!stats) {
      return rebuildJsonResponse(response, JSON.stringify(data));
    }

    emitStats(stats);
    return rebuildJsonResponse(response, JSON.stringify(data));
  };
})();
