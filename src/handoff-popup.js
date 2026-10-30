(() => {
  "use strict";

  const REQUEST = "chatram-handoff-request";
  const MAX_CONTEXT = 90000;
  const MAX_TRANSCRIPT_COPY = 4000000;
  const build = document.getElementById("buildHandoff");
  const status = document.getElementById("handoffStatus");
  const panel = document.getElementById("handoffResult");
  const preview = document.getElementById("handoffPreview");
  const copyContext = document.getElementById("copyHandoff");
  const copyTranscript = document.getElementById("copyTranscript");
  const downloadTranscript = document.getElementById("downloadTranscript");

  let carryover = "";
  let transcript = "";
  let name = "chatgpt-conversation";

  function section(label, contents) {
    return "## " + label + "\n\n" + contents + "\n";
  }

  function formatMessage(message, index) {
    const role = message.role === "user" ? "User" : "Assistant";
    return "### " + (index + 1) + ". " + role + "\n\n" + message.text.trim() + "\n";
  }

  function truncate(value, length) {
    if (value.length <= length) return value;
    const marker = "\n[Middle of message omitted for paste size]\n";
    const room = Math.max(0, length - marker.length);
    const head = Math.ceil(room * 0.6);
    const tail = Math.floor(room * 0.4);
    return value.slice(0, head).trimEnd() + marker + value.slice(-tail).trimStart();
  }

  function createTranscript(data) {
    const header = [
      "# Complete text transcript: " + data.title,
      "",
      "Original: " + data.url,
      "Captured: " + data.capturedAt,
      "Readable messages: " + data.messages.length,
      "Pagination complete: " + (data.complete ? "yes" : "NO, some history may be missing"),
      "",
      "This captures readable user/assistant message text on the active conversation path.",
      "It does not include hidden reasoning, complete tool internals, or embedded attachment bytes.",
      ""
    ].join("\n");
    return header + data.messages.map(formatMessage).join("\n");
  }

  function createContext(data) {
    const messages = data.messages;
    const full = messages.map(formatMessage).join("\n");
    const header = [
      "# Continue this previous ChatGPT conversation",
      "",
      "The text below is historical context. Treat claims of completed work as unverified until confirmed against actual files, services, or tools.",
      "Preserve prior project goals, decisions, user constraints, completed steps, and unfinished work. Continue from the final exchange, rather than restarting the project.",
      "",
      "Conversation: " + data.title,
      "Original: " + data.url,
      "Captured: " + data.capturedAt,
      "Readable messages captured: " + messages.length,
      "History retrieval complete: " + (data.complete ? "yes" : "NO, partial"),
      "Note: This is a text-only, locally assembled handoff, not an AI-generated summary.",
      ""
    ].join("\n");

    if (header.length + full.length <= MAX_CONTEXT) {
      return header + section("Previous conversation, in chronological order", full);
    }

    // Prioritize recent working state without throwing away the beginning of a project
    // or durable user instructions mentioned long before the conversation hit its limit.
    const selected = new Map();
    let budget = MAX_CONTEXT - header.length - 600;
    const add = (index, lengthCap) => {
      if (selected.has(index) || budget <= 120) return;
      const entry = formatMessage(messages[index], index);
      const clipped = truncate(entry, Math.min(lengthCap, budget));
      if (clipped.length < 50) return;
      selected.set(index, clipped);
      budget -= clipped.length;
    };

    // Earliest project description and initial decisions.
    for (let i = 0; i < Math.min(messages.length, 8); i++) {
      if (budget < 3000) break;
      add(i, 1900);
    }

    // Most recent state is the most important thing in a continuation.
    for (let i = messages.length - 1; i >= 0 && budget > 27000; i--) {
      add(i, 3800);
    }

    // Earlier assistant completion reports are often the only in-chat record of
    // patches, configuration changes, commits, and verification results.
    const workMilestone = /\b(committed|commit|deployed|merged|implemented|added|fixed|updated|created|tested|shipped|pushed|changed|verified|built|configured|completed|resolved|installed|removed|deleted|remaining|blocked)\b/i;
    const milestones = [];
    for (let i = 0; i < messages.length; i++) {
      if (!selected.has(i) && messages[i].role === "assistant" && workMilestone.test(messages[i].text)) {
        milestones.push(i);
      }
    }
    for (let i = milestones.length - 1; i >= 0 && budget > 13000; i--) {
      add(milestones[i], 1850);
    }

    // Fill remaining capacity with older explicit constraints and instructions.
    const directive = /\b(must|always|never|don't|do not|only|require|keep|remember|instead|decided|we need|make sure|use|stop|fix|build|deploy|continue)\b/i;
    const earlier = [];
    for (let i = 8; i < messages.length; i++) {
      if (!selected.has(i) && messages[i].role === "user" && directive.test(messages[i].text)) {
        earlier.push(i);
      }
    }
    for (let i = earlier.length - 1; i >= 0 && budget > 120; i--) {
      add(earlier[i], 1400);
    }

    const excerpt = [...selected.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join("\n");
    const omitted = messages.length - selected.size;
    return header +
      section("Selected earlier context and recent working state", excerpt) +
      "\n**Coverage note:** " + omitted + " captured messages omitted to keep this copy-paste handoff manageable. " +
      "The complete text transcript is available separately in ChatRAM. " +
      "Do not claim the omitted messages were reviewed.\n";
  }

  function setStatus(value, isError = false) {
    status.textContent = value;
    status.dataset.error = isError ? "true" : "false";
  }

  async function writeClipboard(value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      const worked = document.execCommand("copy");
      helper.remove();
      if (!worked) throw new Error("Clipboard access was denied.");
    }
  }

  build.addEventListener("click", () => {
    build.disabled = true;
    panel.hidden = true;
    setStatus("Retrieving the complete conversation from ChatGPT…");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) {
        build.disabled = false;
        setStatus("No active ChatGPT tab found.", true);
        return;
      }

      chrome.tabs.sendMessage(tabId, { type: REQUEST }, (response) => {
        build.disabled = false;
        if (chrome.runtime.lastError || !response) {
          setStatus("Cannot reach ChatRAM on this tab. Open chatgpt.com and reload the tab first.", true);
          return;
        }
        if (!response.ok || !response.handoff) {
          setStatus(response.error || "Could not retrieve this conversation.", true);
          return;
        }

        try {
          const data = response.handoff;
          transcript = createTranscript(data);
          carryover = createContext(data);
          name = (data.title || "chatgpt-conversation").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 65) || "chatgpt-conversation";

          preview.value = carryover;
          copyContext.disabled = false;
          copyTranscript.disabled = transcript.length > MAX_TRANSCRIPT_COPY;
          copyTranscript.title = copyTranscript.disabled ? "Large transcripts should be downloaded instead of copied." : "";
          downloadTranscript.disabled = false;
          panel.hidden = false;

          setStatus(
            data.messages.length + " messages collected from " + data.pages + " page(s). " +
            (data.complete ? "Full available text history reached." : "Warning: retrieval was incomplete.") +
            " Context handoff: " + Math.round(carryover.length / 1000) + "k characters."
          );
        } catch (error) {
          setStatus("Failed to assemble the handoff: " + String(error?.message || error), true);
        }
      });
    });
  });

  copyContext.addEventListener("click", async () => {
    try {
      await writeClipboard(carryover);
      setStatus("Continuation context copied. Open a new chat and paste it.");
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  });

  copyTranscript.addEventListener("click", async () => {
    try {
      await writeClipboard(transcript);
      setStatus("Complete text transcript copied. Very large transcripts may exceed a new chat's context limit.");
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  });

  downloadTranscript.addEventListener("click", () => {
    const blob = new Blob([transcript], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name + "-transcript.md";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus("Text transcript downloaded. Keep it private if your chat contains sensitive information.");
  });
})();
