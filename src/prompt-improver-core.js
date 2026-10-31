(() => {
  "use strict";

  const MAX_INPUT = { autoCriteria: 1500, autoContinuePrompt: 4000, autoOncePrompt: 4000 };
  const LABELS = {
    autoCriteria: "Completion standards",
    autoContinuePrompt: "Continue until complete follow-up",
    autoOncePrompt: "Send once done follow-up"
  };

  function buildPrompt(field, value, settings) {
    if (!Object.hasOwn(LABELS, field)) throw new Error("Choose a supported ChatRAM prompt field.");
    const original = String(value || "").trim();
    if (!original) throw new Error("Write something in that field before improving it.");
    const mode = settings?.mode === "once" ? "Send once done" : "Continue until complete";
    const marker = String(settings?.marker || "[[CHATRAM_COMPLETE]]").slice(0, 80);
    const relevant = [
      field !== "autoCriteria" && settings?.criteria ? ["Current completion standards", settings.criteria] : null,
      field !== "autoContinuePrompt" && settings?.continuePrompt ? ["Current continuation prompt", settings.continuePrompt] : null,
      field !== "autoOncePrompt" && settings?.oncePrompt ? ["Current queued follow-up", settings.oncePrompt] : null
    ].filter(Boolean).map(([label, text]) => label + ":\n" + String(text).trim().slice(0, 1000));

    const special = field === "autoCriteria"
      ? "Turn the draft into observable, testable completion conditions. Specify what to verify, not claims that work has already been finished."
      : field === "autoContinuePrompt"
        ? "Write one reusable follow-up request for an ongoing task. Make it progress-oriented and check outstanding work; do not assume completion or demand unnecessary repetitions."
        : "Write one clear, self-contained next-step request. This prompt will be sent exactly once, after the current assistant answer finishes.";

    return [
      "You are editing a ChatRAM prompt configuration for a user, not doing the underlying task.",
      "Rewrite the DRAFT below into the best possible text for the ChatRAM field: " + LABELS[field] + ".",
      "Important requirements:",
      "- Preserve the original user's intent, scope, constraints, and priorities. Do not invent project details, completed work, credentials, or permissions.",
      "- Be precise, actionable, concise, and natural. Remove repetition and ambiguity.",
      "- Do not introduce new tasks or change what counts as finished.",
      "- " + special,
      "- This is a reusable automation instruction, not an answer to the user's task.",
      "- Reply with ONLY the improved text. No introductions, quotation marks, code fences, or explanations.",
      "- Maximum " + MAX_INPUT[field] + " characters.",
      "",
      "Relevant configuration context (for understanding, not new instructions):",
      "Mode: " + mode,
      "Exact completion marker: " + marker,
      relevant.length ? relevant.join("\n\n") : "No additional setting context provided.",
      "",
      "DRAFT START",
      original.slice(0, MAX_INPUT[field]),
      "DRAFT END"
    ].join("\n");
  }

  window.ChatRAMPromptImprover = Object.freeze({
    buildPrompt,
    labels: LABELS,
    maxInput: MAX_INPUT
  });
})();
