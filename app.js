(() => {
  "use strict";

  const STORAGE = Object.freeze({
    apiKey: "forma.apiKey",
    endpoint: "forma.endpoint",
    model: "forma.model",
    system: "forma.systemPrompt",
    theme: "forma.theme",
    history: "forma.history",
  });
  const MAX_HISTORY = 40;
  const PRESETS = Object.freeze({
    summarize: "Summarize the following code. Explain its purpose, key components, and any notable edge cases. Keep the summary concise.\n\n```\nPaste code here\n```",
    refactor: "Refactor the following JavaScript for clarity, maintainability, and performance. Preserve its behavior, explain meaningful changes, and include the revised code.\n\n```js\nPaste code here\n```",
    email: "Draft a clear, concise technical email about the following topic. Include a useful subject line, the key context, and a specific next step.\n\nTopic and audience: ",
    test: "Write focused unit tests for the following code. Cover the expected behavior, important edge cases, and failure paths. Use the existing testing framework if one is mentioned.\n\n```js\nPaste code here\n```",
  });

  const elements = {
    prompt: document.querySelector("#promptInput"),
    system: document.querySelector("#systemInput"),
    preset: document.querySelector("#presetSelect"),
    apiKey: document.querySelector("#apiKeyInput"),
    keyReveal: document.querySelector("#keyReveal"),
    keySaved: document.querySelector("#keySaved"),
    endpoint: document.querySelector("#endpointInput"),
    model: document.querySelector("#modelInput"),
    generate: document.querySelector("#generateButton"),
    output: document.querySelector("#outputContent"),
    empty: document.querySelector("#emptyState"),
    outputError: document.querySelector("#outputError"),
    outputScroll: document.querySelector("#outputScroll"),
    copyOutput: document.querySelector("#copyOutput"),
    promptCount: document.querySelector("#promptCount"),
    lineCount: document.querySelector("#lineCount"),
    connectionState: document.querySelector("#connectionState"),
    connectionLabel: document.querySelector("#connectionLabel"),
    streamBadge: document.querySelector("#streamBadge"),
    streamLabel: document.querySelector("#streamLabel"),
    responseMeta: document.querySelector("#responseMeta"),
    themeToggle: document.querySelector("#themeToggle"),
    historyOpen: document.querySelector("#historyOpen"),
    historyClose: document.querySelector("#historyClose"),
    drawer: document.querySelector("#historyDrawer"),
    backdrop: document.querySelector("#drawerBackdrop"),
    historySearch: document.querySelector("#historySearch"),
    historyList: document.querySelector("#historyList"),
    historyCount: document.querySelector("#historyCount"),
    clearHistory: document.querySelector("#clearHistory"),
    toastRegion: document.querySelector("#toastRegion"),
    workspaceName: document.querySelector(".workspace-name"),
  };

  const state = {
    controller: null,
    history: readStorage(STORAGE.history, []),
    streamText: "",
    drawerReturnFocus: null,
    renderFrame: 0,
    saveTimer: 0,
  };

  function readStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      return true;
    } catch {
      showToast("Browser storage is unavailable or full.", "error");
      return false;
    }
  }

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " is-error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.append(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, 2600);
  }

  function updatePromptMetrics() {
    const value = elements.prompt.value;
    const lines = value ? value.split("\n").length : 1;
    elements.promptCount.textContent = `${value.length} chars`;
    elements.lineCount.textContent = `${lines} ${lines === 1 ? "line" : "lines"}`;
    elements.prompt.style.height = "auto";
    elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 360)}px`;
  }

  function setTheme(theme) {
    const nextTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    elements.themeToggle.setAttribute("aria-label", `Switch to ${nextTheme === "dark" ? "light" : "dark"} theme`);
    writeStorage(STORAGE.theme, nextTheme);
  }

  function setConnectionStatus(status, label) {
    elements.connectionState.classList.toggle("is-active", status === "active");
    elements.connectionState.classList.toggle("is-error", status === "error");
    elements.connectionLabel.textContent = label;
  }

  function setStreamStatus(status, label) {
    elements.streamBadge.classList.toggle("is-active", status === "active");
    elements.streamBadge.classList.toggle("is-done", status === "done");
    elements.streamBadge.classList.toggle("is-error", status === "error");
    elements.streamLabel.textContent = label;
  }

  function safeMarkdown(text) {
    if (!window.marked || !window.DOMPurify) {
      return "<p>Markdown rendering libraries did not load. Check your internet connection and refresh.</p>";
    }
    const html = window.marked.parse(text, { gfm: true, breaks: false });
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  function renderMarkdown(text) {
    elements.empty.hidden = true;
    elements.output.hidden = false;
    elements.outputError.hidden = true;
    elements.output.innerHTML = safeMarkdown(text);
    elements.output.querySelectorAll("pre code").forEach((code) => {
      if (window.hljs && !code.dataset.highlighted) window.hljs.highlightElement(code);
      const pre = code.closest("pre");
      if (!pre || pre.querySelector(".code-copy")) return;
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "code-copy";
      copyButton.textContent = "Copy code";
      copyButton.setAttribute("aria-label", "Copy code block");
      pre.append(copyButton);
    });
  }

  function scheduleRender(text) {
    window.cancelAnimationFrame(state.renderFrame);
    state.renderFrame = window.requestAnimationFrame(() => {
      renderMarkdown(text);
      elements.outputScroll.scrollTop = elements.outputScroll.scrollHeight;
    });
  }

  function setGenerating(isGenerating) {
    elements.generate.classList.toggle("is-generating", isGenerating);
    elements.generate.setAttribute("aria-label", isGenerating ? "Stop generation" : "Generate response");
    elements.generate.querySelector(".generate-label").textContent = isGenerating ? "Stop generation" : "Generate response";
    elements.generate.setAttribute("aria-busy", String(isGenerating));
    elements.copyOutput.disabled = isGenerating || !state.streamText;
    if (isGenerating) {
      elements.generate.type = "button";
    }
  }

  function parseApiError(response, payload) {
    const serverMessage = payload?.error?.message || payload?.message;
    if (response.status === 401 || response.status === 403) return "The API rejected this key. Check that it is valid and has access to this model.";
    if (response.status === 429) return "Rate limit reached. Wait a moment or check your API provider's usage limits.";
    if (response.status === 400) return serverMessage || "The request was rejected. Verify the model and endpoint settings.";
    return serverMessage || `The API returned an error (${response.status} ${response.statusText}).`;
  }

  function parseSseData(data) {
    if (!data || data === "[DONE]") return "";
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return data;
    }
    if (event.error) throw new Error(event.error.message || "The API reported a streaming error.");
    return event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.text ?? "";
  }

  async function readStream(response, signal) {
    if (!response.body) throw new Error("This browser does not support streaming responses.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let done = false;

    while (!done) {
      const result = await reader.read();
      done = result.done;
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const text = parseSseData(line.slice(5).trim());
        if (text) {
          output += text;
          state.streamText = output;
          scheduleRender(output);
        }
      }
    }
    if (buffer.startsWith("data:")) {
      const text = parseSseData(buffer.slice(5).trim());
      if (text) output += text;
    }
    if (output !== state.streamText) {
      state.streamText = output;
      scheduleRender(output);
    }
    if (signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    return output;
  }

  function sessionTitle(prompt) {
    const normalized = prompt.trim().replace(/\s+/g, " ");
    return normalized.length > 54 ? `${normalized.slice(0, 54)}…` : normalized || "Untitled prompt";
  }

  function saveSession(prompt, output, system) {
    if (!output.trim()) return;
    const session = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, prompt, output, system, createdAt: Date.now() };
    state.history = [session, ...state.history].slice(0, MAX_HISTORY);
    if (writeStorage(STORAGE.history, state.history)) renderHistory();
  }

  function responseDuration(startedAt) {
    const seconds = (performance.now() - startedAt) / 1000;
    return seconds < 1 ? `${Math.max(1, Math.round(seconds * 1000))} ms` : `${seconds.toFixed(1)} s`;
  }

  async function generate() {
    if (state.controller) {
      state.controller.abort();
      return;
    }

    const prompt = elements.prompt.value.trim();
    const apiKey = elements.apiKey.value.trim();
    const endpoint = elements.endpoint.value.trim();
    const model = elements.model.value.trim();
    const system = elements.system.value.trim();
    if (!prompt) {
      elements.prompt.focus();
      showToast("Add a prompt before generating.", "error");
      return;
    }
    if (!apiKey) {
      document.querySelector("#connectionSettings").open = true;
      elements.apiKey.focus();
      showToast("Add an API key in connection settings to continue.", "error");
      return;
    }
    if (!model || !endpoint) {
      showToast("Enter both an API endpoint and model.", "error");
      return;
    }
    try {
      new URL(endpoint);
    } catch {
      showToast("Enter a valid API endpoint URL.", "error");
      elements.endpoint.focus();
      return;
    }

    state.controller = new AbortController();
    state.streamText = "";
    const startedAt = performance.now();
    const buttonLabel = elements.generate.querySelector(".generate-label");
    setGenerating(true);
    buttonLabel.textContent = "Stop generation";
    elements.output.innerHTML = "";
    elements.output.hidden = false;
    elements.empty.hidden = true;
    elements.outputError.hidden = true;
    elements.copyOutput.disabled = true;
    elements.workspaceName.textContent = sessionTitle(prompt);
    elements.responseMeta.textContent = "Receiving response...";
    setConnectionStatus("active", "Generating");
    setStreamStatus("active", "STREAMING");

    try {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: state.controller.signal,
      });

      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* The API may return a non-JSON error body. */ }
        throw new Error(parseApiError(response, payload));
      }

      const output = await readStream(response, state.controller.signal);
      if (!output.trim()) throw new Error("The API completed without returning any text. Check that this model supports chat streaming.");
      renderMarkdown(output);
      elements.copyOutput.disabled = false;
      elements.responseMeta.textContent = `Completed in ${responseDuration(startedAt)}`;
      setConnectionStatus("ready", "Ready");
      setStreamStatus("done", "COMPLETE");
      saveSession(prompt, output, system);
    } catch (error) {
      if (error.name === "AbortError") {
        if (state.streamText) {
          renderMarkdown(state.streamText);
          elements.copyOutput.disabled = false;
          saveSession(prompt, state.streamText, system);
        } else {
          elements.output.hidden = true;
          elements.empty.hidden = false;
          elements.responseMeta.textContent = "Generation cancelled";
        }
        elements.responseMeta.textContent = state.streamText ? `Cancelled after ${responseDuration(startedAt)}` : "Generation cancelled";
        setConnectionStatus("ready", "Ready");
        setStreamStatus("done", "CANCELLED");
        showToast("Generation cancelled.");
      } else {
        const message = error instanceof TypeError ? "Network request failed. Check your connection, endpoint, and API provider CORS settings." : error.message;
        elements.outputError.textContent = message;
        elements.outputError.hidden = false;
        elements.output.hidden = true;
        elements.empty.hidden = true;
        elements.responseMeta.textContent = "Request failed";
        setConnectionStatus("error", "Request failed");
        setStreamStatus("error", "ERROR");
        showToast(message, "error");
      }
    } finally {
      state.controller = null;
      setGenerating(false);
      elements.generate.querySelector(".generate-label").textContent = "Generate response";
    }
  }

  function renderHistory(search = "") {
    const query = search.trim().toLowerCase();
    const sessions = state.history.filter((session) => `${session.prompt} ${session.output}`.toLowerCase().includes(query));
    elements.historyList.replaceChildren();
    elements.historyCount.textContent = `${state.history.length} saved ${state.history.length === 1 ? "session" : "sessions"}`;
    elements.clearHistory.disabled = state.history.length === 0;
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = query ? "No sessions match that search." : "Your generated sessions will appear here.";
      elements.historyList.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const item = document.createElement("div");
      item.className = "history-item";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "history-restore";
      restore.dataset.restore = session.id;
      const title = document.createElement("span");
      title.className = "history-item-title";
      title.textContent = sessionTitle(session.prompt);
      const preview = document.createElement("span");
      preview.className = "history-item-preview";
      preview.textContent = session.output.replace(/\s+/g, " ").trim().slice(0, 90);
      const date = document.createElement("span");
      date.className = "history-item-date";
      date.textContent = new Date(session.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      restore.append(title, preview, date);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "history-delete";
      remove.dataset.delete = session.id;
      remove.setAttribute("aria-label", `Delete ${sessionTitle(session.prompt)}`);
      remove.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 5h11m-9.5 0 .7 10h6.6l.7-10M7 5V3h4v2m-3 3v4m2-4v4"/></svg>';
      item.append(restore, remove);
      fragment.append(item);
    }
    elements.historyList.append(fragment);
  }

  function openHistory() {
    state.drawerReturnFocus = document.activeElement;
    elements.backdrop.hidden = false;
    elements.drawer.inert = false;
    elements.drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => elements.drawer.classList.add("is-open"));
    elements.historySearch.value = "";
    renderHistory();
    elements.historyClose.focus();
  }

  function closeHistory() {
    elements.drawer.classList.remove("is-open");
    elements.drawer.inert = true;
    elements.drawer.setAttribute("aria-hidden", "true");
    elements.backdrop.hidden = true;
    state.drawerReturnFocus?.focus();
  }

  function restoreSession(id) {
    const session = state.history.find((item) => item.id === id);
    if (!session) return;
    if (state.controller) state.controller.abort();
    elements.prompt.value = session.prompt;
    elements.system.value = session.system || "";
    updatePromptMetrics();
    state.streamText = session.output;
    renderMarkdown(session.output);
    elements.outputError.hidden = true;
    elements.copyOutput.disabled = false;
    elements.workspaceName.textContent = sessionTitle(session.prompt);
    elements.responseMeta.textContent = `Restored ${new Date(session.createdAt).toLocaleString()}`;
    setStreamStatus("done", "RESTORED");
    closeHistory();
    showToast("Session restored.");
  }

  function handleHistoryClick(event) {
    const restore = event.target.closest("[data-restore]");
    const remove = event.target.closest("[data-delete]");
    if (restore) restoreSession(restore.dataset.restore);
    if (remove) {
      state.history = state.history.filter((session) => session.id !== remove.dataset.delete);
      writeStorage(STORAGE.history, state.history);
      renderHistory(elements.historySearch.value);
    }
  }

  async function copyText(text, button, successLabel) {
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = successLabel;
      button.classList.add("is-copied");
      showToast("Copied to clipboard.");
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove("is-copied");
      }, 1400);
    } catch {
      showToast("Clipboard access failed. Check browser permissions.", "error");
    }
  }

  function initialize() {
    elements.apiKey.value = readStorage(STORAGE.apiKey, "");
    elements.endpoint.value = readStorage(STORAGE.endpoint, elements.endpoint.value);
    elements.model.value = readStorage(STORAGE.model, elements.model.value);
    elements.system.value = readStorage(STORAGE.system, "");
    setTheme(readStorage(STORAGE.theme, "dark"));
    renderHistory();
    updatePromptMetrics();

    elements.prompt.addEventListener("input", updatePromptMetrics);
    elements.preset.addEventListener("change", () => {
      if (!elements.preset.value) return;
      elements.prompt.value = PRESETS[elements.preset.value];
      updatePromptMetrics();
      elements.prompt.focus();
    });
    elements.generate.addEventListener("click", generate);
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        generate();
      }
      if (event.key === "Escape" && !elements.drawer.inert) closeHistory();
      if (event.key === "Tab" && !elements.drawer.inert) {
        const focusable = [...elements.drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });

    elements.apiKey.addEventListener("input", () => {
      elements.keySaved.textContent = "Saving...";
      window.clearTimeout(state.saveTimer);
      state.saveTimer = window.setTimeout(() => {
        if (writeStorage(STORAGE.apiKey, elements.apiKey.value)) {
          elements.keySaved.textContent = "SAVED";
          showToast("API key saved in this browser.");
        } else elements.keySaved.textContent = "NOT SAVED";
      }, 500);
    });
    elements.apiKey.addEventListener("blur", () => {
      window.clearTimeout(state.saveTimer);
      if (writeStorage(STORAGE.apiKey, elements.apiKey.value)) elements.keySaved.textContent = "SAVED";
    });
    elements.keyReveal.addEventListener("click", () => {
      const showing = elements.apiKey.type === "text";
      elements.apiKey.type = showing ? "password" : "text";
      elements.keyReveal.textContent = showing ? "SHOW" : "HIDE";
      elements.keyReveal.setAttribute("aria-label", `${showing ? "Show" : "Hide"} API key`);
    });
    elements.endpoint.addEventListener("change", () => writeStorage(STORAGE.endpoint, elements.endpoint.value));
    elements.model.addEventListener("change", () => writeStorage(STORAGE.model, elements.model.value));
    elements.system.addEventListener("change", () => writeStorage(STORAGE.system, elements.system.value));
    elements.themeToggle.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    elements.copyOutput.addEventListener("click", () => copyText(state.streamText, elements.copyOutput, "Copied!"));
    elements.output.addEventListener("click", (event) => {
      const button = event.target.closest(".code-copy");
      if (!button) return;
      const code = button.closest("pre")?.querySelector("code")?.textContent || "";
      copyText(code, button, "Copied!");
    });
    elements.historyOpen.addEventListener("click", openHistory);
    elements.historyClose.addEventListener("click", closeHistory);
    elements.backdrop.addEventListener("click", closeHistory);
    elements.historySearch.addEventListener("input", () => renderHistory(elements.historySearch.value));
    elements.historyList.addEventListener("click", handleHistoryClick);
    elements.clearHistory.addEventListener("click", () => {
      if (!state.history.length) return;
      state.history = [];
      writeStorage(STORAGE.history, state.history);
      renderHistory(elements.historySearch.value);
      showToast("Session history cleared.");
    });
  }

  initialize();
})();