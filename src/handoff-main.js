(() => {
  "use strict";

  // Capture the original fetch before ChatRAM's memory-saving wrapper is installed.
  // Handoff requests must read the full history without forcing ChatGPT to render it.
  const fetchOriginal = window.fetch.bind(window);
  const SOURCE = "chatgpt-speedup";
  const MAX_PAGES = 500;
  const MAX_MESSAGES = 30000;
  const MAX_CHARACTERS = 12000000;

  function conversationId() {
    const match = window.location.pathname.match(/(?:^|\/)c\/([a-z0-9-]{12,100})(?:\/|$)/i);
    return match ? match[1] : null;
  }

  function textFromPart(value, depth = 0) {
    if (depth > 4 || value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value.map((part) => textFromPart(part, depth + 1)).filter(Boolean).join("\n");
    }
    if (typeof value !== "object") return "";
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.parts)) return textFromPart(value.parts, depth + 1);
    if (Array.isArray(value.content?.parts)) return textFromPart(value.content.parts, depth + 1);
    if (value.content_type === "image_asset_pointer" || value.asset_pointer) return "[Image attachment]";
    if (value.content_type === "audio_asset_pointer" || value.audio_asset_pointer) return "[Audio attachment]";
    if (value.content_type === "video_asset_pointer") return "[Video attachment]";
    return "";
  }

  function normalizeRow(row) {
    const msg = row?.message || row;
    if (!msg || typeof msg !== "object") return null;

    const role = msg.author?.role || msg.role;
    if (role !== "user" && role !== "assistant") return null;
    if (msg.metadata?.is_visually_hidden_from_conversation || msg.metadata?.is_hidden) return null;

    const channel = String(msg.metadata?.channel || msg.channel || "").toLowerCase();
    // Analysis and other private/internal channels are never part of a handoff.
    if (channel && !["final", "commentary", "complete"].includes(channel)) return null;
    if (role === "assistant" && msg.recipient && msg.recipient !== "all") return null;

    const content = textFromPart(msg.content || msg.message?.content);
    if (!content.trim()) return null;
    const timestamp = Number(msg.create_time || row?.create_time || 0);

    return {
      id: String(msg.id || row?.id || ""),
      role,
      text: content,
      time: Number.isFinite(timestamp) ? timestamp : 0
    };
  }

  function appendRows(rows, unique, result, budget) {
    for (const row of rows) {
      const item = normalizeRow(row);
      if (!item) continue;
      const key = item.id || item.role + ":" + item.time + ":" + item.text.slice(0, 200);
      if (unique.has(key)) continue;
      if (budget.count >= MAX_MESSAGES || budget.characters + item.text.length > MAX_CHARACTERS) {
        return false;
      }
      unique.add(key);
      result.push(item);
      budget.count += 1;
      budget.characters += item.text.length;
    }
    return true;
  }

  async function accessToken() {
    try {
      const response = await fetchOriginal("/api/auth/session", { credentials: "same-origin" });
      if (!response.ok) return null;
      const session = await response.json();
      return typeof session?.accessToken === "string" ? session.accessToken : null;
    } catch {
      return null;
    }
  }

  async function requestJson(path, token) {
    const headers = token ? { authorization: "Bearer " + token } : {};
    const response = await fetchOriginal(path, {
      method: "GET",
      credentials: "same-origin",
      headers,
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("ChatGPT history request failed (HTTP " + response.status + ").");
    }
    return response.json();
  }

  function titleFrom(data) {
    const fromApi = typeof data?.title === "string" ? data.title.trim() : "";
    return fromApi || document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation";
  }

  async function fetchPaginated(id, token) {
    let cursor = null;
    let pages = 0;
    let complete = false;
    let title = "";
    const unique = new Set();
    const messages = [];
    const budget = { characters: 0, count: 0 };

    while (pages < MAX_PAGES) {
      const url = new URL("/backend-api/conversations/" + encodeURIComponent(id), window.location.origin);
      url.searchParams.set("num_turns", "100");
      url.searchParams.set("include_has_versions", "true");
      if (cursor) url.searchParams.set("before", cursor);

      const data = await requestJson(url.pathname + url.search, token);
      if (!Array.isArray(data?.messages)) {
        throw new Error("ChatGPT returned an unfamiliar conversation format.");
      }
      if (!title) title = titleFrom(data);
      pages += 1;

      const pageRows = [];
      const accepted = appendRows(data.messages, unique, pageRows, budget);
      // The endpoint returns newest pages first. Prepend older pages in order.
      messages.unshift(...pageRows);
      if (!accepted) break;

      const pageInfo = data.page_info;
      if (pageInfo?.has_previous_page === false) {
        complete = true;
        break;
      }
      const nextCursor = pageInfo?.start_cursor;
      if (!pageInfo?.has_previous_page || typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }

    messages.sort((a, b) => a.time && b.time ? a.time - b.time : 0);
    return { title, messages, pages, complete };
  }

  async function fetchLegacy(id, token) {
    const data = await requestJson("/backend-api/conversation/" + encodeURIComponent(id), token);
    if (!data?.mapping || !data.current_node) {
      throw new Error("Neither of ChatGPT's known conversation formats was available.");
    }

    const backward = [];
    const visited = new Set();
    let cursor = data.current_node;
    let complete = true;

    while (cursor && data.mapping[cursor] && !visited.has(cursor)) {
      visited.add(cursor);
      backward.push(data.mapping[cursor]);
      cursor = data.mapping[cursor].parent;
      if (backward.length >= MAX_MESSAGES) {
        complete = false;
        break;
      }
    }

    const messages = [];
    const budget = { characters: 0, count: 0 };
    const accepted = appendRows(backward.reverse(), new Set(), messages, budget);
    return {
      title: titleFrom(data),
      messages,
      pages: 1,
      complete: complete && accepted && !cursor
    };
  }

  async function captureConversation() {
    const id = conversationId();
    if (!id) throw new Error("Open a saved ChatGPT conversation before creating a handoff.");

    const token = await accessToken();
    let result;
    try {
      result = await fetchPaginated(id, token);
    } catch (paginationError) {
      try {
        result = await fetchLegacy(id, token);
      } catch {
        throw paginationError;
      }
    }

    if (!result.messages.length) {
      throw new Error("No readable user or assistant text was found in this conversation.");
    }
    return {
      ...result,
      id,
      url: window.location.origin + window.location.pathname,
      capturedAt: new Date().toISOString(),
      textOnly: true
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "handoff-request") {
      return;
    }
    const requestId = event.data.requestId;
    if (typeof requestId !== "string" || requestId.length > 100) return;

    void captureConversation().then(
      (handoff) => window.postMessage({ source: SOURCE, type: "handoff-response", requestId, handoff }, window.location.origin),
      (error) => window.postMessage({ source: SOURCE, type: "handoff-response", requestId, error: String(error?.message || error) }, window.location.origin)
    );
  });
})();
