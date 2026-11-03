"use strict";
(() => {
  const C = window.ExplorerCore;
  const P = window.ExplorerProviders;
  const $ = id => document.getElementById(id);
  const key = $("api-key"), model = $("model"), prompt = $("prompt");
  const history = [];
  let providerId = "openai", initialRows = "";
  const adapter = () => P.presets[providerId];
  let selected = null, nextId = 1, rowId = 1, sending = false, verification = "idle", settingsVersion = 0;
  let verifyController = null, requestController = null;
  const TIMEOUT_MS = 60000;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function buttons() {
    const configured = Boolean(adapter().available && key.value.trim() && model.value.trim());
    key.disabled = !adapter().available;
    $("verify").disabled = !configured || verification === "checking" || sending;
    $("verify").hidden = verification === "verified";
    $("verified").hidden = verification !== "verified";
    $("verify").textContent = verification === "checking" ? "Checking…" : "Verify";
    $("send").disabled = !configured || !prompt.value.trim() || sending || verification === "checking";
    $("send").querySelector("span").textContent = sending ? "Sending…" : "Send";
    $("clear").disabled = sending || !history.length;
  }
  function connectionMessage(text = "", kind = "") {
    $("connection-message").textContent = text;
    $("connection-message").className = `connection-message ${kind}`;
    $("connection-message").hidden = !text;
  }
  function resetVerification() {
    settingsVersion++;
    verifyController?.abort();
    verifyController = null;
    verification = "idle";
    key.removeAttribute("aria-invalid");
    connectionMessage();
    buttons();
  }
  function rowData() {
    return [...$("parameter-rows").children].map(row => ({ enabled: row.querySelector(".row-enabled").checked, key: row.querySelector(".row-key").value, value: row.querySelector(".row-value").value }));
  }
  function updateProviderUI() {
    const current = adapter();
    $("endpoint").textContent = current.endpoint(model.value.trim());
    $("parameter-help").textContent = providerId === "gemini" ? "Enabled rows become generationConfig fields without changing their values. JSON Schema needs both responseMimeType and responseJsonSchema. Quote string values." : providerId === "anthropic" ? "max_tokens is mandatory and must stay enabled. Other controls are optional. Values use JSON; quote strings." : "Enabled rows are sent unchanged. Optional rows start disabled. Values use JSON; quote strings.";
  }
  function populateModels() {
    $("model-choice").replaceChildren();
    for (const [id, title] of adapter().models) { const option = element("option", "", title); option.value = id; $("model-choice").append(option); }
    const custom = element("option", "", "Custom model ID…"); custom.value = "custom"; $("model-choice").append(custom);
    model.value = adapter().defaultModel; $("model-choice").value = model.value; $("custom-model-field").hidden = true;
    updateProviderUI();
  }
  function populateRows() {
    for (const input of $("parameter-rows").querySelectorAll(".row-value")) valueObserver?.unobserve(input);
    $("parameter-rows").replaceChildren();
    for (const row of adapter().defaults()) addRow(...row);
    initialRows = JSON.stringify(rowData());
  }
  function sizeValue(input) {
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const minimum = line + padding + border, maximum = 4 * line + padding + border;
    // Measure at the current width without changing the value, including wrapped lines.
    input.style.overflowY = "hidden";
    input.style.height = "0px";
    const contentHeight = input.scrollHeight + border;
    input.style.height = `${Math.min(maximum, Math.max(minimum, contentHeight))}px`;
    input.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
  }
  function sizeValues() { for (const input of $("parameter-rows").querySelectorAll(".row-value")) sizeValue(input); }
  const valueWidths = new WeakMap();
  const valueObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
    for (const entry of entries) {
      const width = entry.contentRect.width;
      if (valueWidths.get(entry.target) !== width) {
        valueWidths.set(entry.target, width);
        requestAnimationFrame(() => sizeValue(entry.target));
      }
    }
  });
  window.addEventListener("resize", sizeValues);
  document.fonts?.ready.then(sizeValues);
  function addRow(name = "", value = "", enabled = false) {
    const id = rowId++, row = element("div", "parameter-row");
    row.setAttribute("role", "row");
    function cell() { const cell = element("div"); cell.setAttribute("role", "cell"); row.append(cell); return cell; }
    const use = element("input"); use.type = "checkbox"; use.checked = enabled; use.className = "row-enabled"; use.setAttribute("aria-label", `Enable parameter row ${id}`); cell().append(use);
    const nameInput = element("input"); nameInput.type = "text"; nameInput.value = name; nameInput.placeholder = "Key"; nameInput.className = "row-key"; nameInput.setAttribute("aria-label", `Parameter key row ${id}`); nameInput.spellcheck = false; cell().append(nameInput);
    const valueInput = element("textarea"); valueInput.value = value; valueInput.rows = 1; valueInput.placeholder = "JSON value"; valueInput.className = "row-value"; valueInput.setAttribute("aria-label", `JSON value row ${id}`); valueInput.spellcheck = false; cell().append(valueInput);
    const actions = cell(); actions.className = "row-actions";
    const remove = element("button", "", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Delete parameter row ${id}`);
    remove.addEventListener("click", () => { valueObserver?.unobserve(valueInput); row.remove(); $("add-row").focus(); });
    actions.append(remove);
    const error = element("p", "row-error"); error.id = `row-error-${id}`; error.hidden = true; error.setAttribute("role", "alert"); row.append(error);
    [use, nameInput, valueInput].forEach(input => { input.setAttribute("aria-describedby", error.id); input.addEventListener("input", () => { error.hidden = true; nameInput.removeAttribute("aria-invalid"); valueInput.removeAttribute("aria-invalid"); }); });
    $("parameter-rows").append(row);
    valueInput.addEventListener("input", () => sizeValue(valueInput));
    valueInput.addEventListener("paste", () => requestAnimationFrame(() => sizeValue(valueInput)));
    sizeValue(valueInput);
    valueObserver?.observe(valueInput);
    return row;
  }
  function readRows() {
    const nodes = [...$("parameter-rows").children];
    const rows = rowData(), result = C.parameters(rows, adapter().reserved);
    const support = P.issues(providerId, model.value.trim(), result.values);
    for (const [name, message] of support) {
      const index = rows.findIndex(row => row.enabled && row.key.trim() === name);
      if (index >= 0) result.errors.set(index, message);
      else { result.errors.set(-1, message); formMessage(message); }
    }
    nodes.forEach((row, i) => {
      const error = row.querySelector(".row-error"), message = result.errors.get(i);
      error.hidden = !message; error.textContent = message || "";
      for (const input of row.querySelectorAll(".row-key, .row-value")) input.setAttribute("aria-invalid", String(Boolean(message)));
    });
    if (result.errors.size) nodes.find((_, index) => result.errors.has(index))?.querySelector(".row-key").focus();
    return result;
  }

  async function api(body, credential, controller, provider, endpoint) {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let status = null, statusText = "";
    try {
      if (!provider.available) return { ok: false, status: null, statusText: "", raw: null, json: false, transport: provider.note };
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", ...provider.headers(credential) },
        body: JSON.stringify(body), signal: controller.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error"
      });
      status = response.status; statusText = response.statusText;
      const text = await response.text();
      let raw = text, json = false;
      try { raw = JSON.parse(text); json = true; } catch { /* Keep non-JSON body, explicitly identified. */ }
      return { ok: response.ok, status, statusText, raw, json };
    } catch {
      return { ok: false, status, statusText, raw: null, json: false, transport: timedOut ? "Request timed out after 60 seconds. No automatic retry was made." : controller.signal.aborted ? "Request cancelled." : "Network/browser failure. The browser cannot distinguish CORS, DNS/TLS, connectivity, or local-file restrictions here." };
    } finally { clearTimeout(timer); }
  }
  function errorMessage(result, id) {
    if (result.transport) return result.transport;
    const general = P.httpError(id, result.status, result.json ? result.raw : null);
    const detail = result.json && typeof result.raw?.error?.message === "string" ? result.raw.error.message : "";
    return `${general}${detail ? `\nAPI: ${detail}` : ""}`;
  }
  $("verify").addEventListener("click", async () => {
    if ($("verify").disabled) return;
    const version = settingsVersion, credential = key.value.trim(), controller = new AbortController(), current = adapter(), id = providerId;
    verifyController = controller; verification = "checking";
    connectionMessage("Checking model access…"); buttons();
    // Independent, deliberately small request; never uses experiment rows/history.
    const result = await api(current.verify(model.value.trim()), credential, controller, current, current.endpoint(model.value.trim()));
    if (version !== settingsVersion || controller !== verifyController) return;
    verifyController = null;
    const valid = result.ok && result.json && !C.explicitError(result.raw) && current.outputs(result.raw)?.some(item => typeof item.text === "string" && !item.refusal && !item.error && !item.state.startsWith("Malformed"));
    verification = valid ? "verified" : "idle";
    if (valid) connectionMessage("Connection verified", "success");
    else {
      const message = result.ok ? "The API returned an unexpected response or refusal; verification did not complete." : errorMessage(result, id);
      connectionMessage(C.redact(`${result.status ? `HTTP ${result.status}. ` : ""}${message}`, credential), "error");
      key.setAttribute("aria-invalid", String(result.status === 401));
    }
    buttons();
  });

  function renderHistory() {
    $("history-empty").hidden = history.length > 0;
    $("history-list").replaceChildren();
    for (const entry of history) {
      const li = element("li"), button = element("button", entry.failed ? "failed" : "");
      button.type = "button"; button.setAttribute("aria-current", String(selected === entry.id));
      button.append(element("span", "", C.label(entry.snapshot.prompt)));
      button.append(element("small", "", `${new Date(entry.timestamp).toLocaleTimeString()} · ${entry.pending ? "Sending…" : entry.status ? `HTTP ${entry.status}` : "Failed"}`));
      button.addEventListener("click", () => { selected = entry.id; render(); });
      li.append(button); $("history-list").append(li);
    }
  }
  function highlightedJSON(text) {
    const pre = element("pre", "json-formatted");
    const tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]|\s+/g;
    let end = 0;
    for (const match of text.matchAll(tokens)) {
      if (match.index > end) pre.append(element("span", "", text.slice(end, match.index)));
      const token = match[0];
      let kind = "";
      if (token.startsWith('"')) kind = /^\s*:/.test(text.slice(match.index + token.length)) ? "key" : "string";
      else if (/^-?\d/.test(token)) kind = "number";
      else if (token === "true" || token === "false") kind = "boolean";
      else if (token === "null") kind = "null";
      pre.append(element("span", kind ? `json-${kind}` : "", token));
      end = match.index + token.length;
    }
    if (end < text.length) pre.append(element("span", "", text.slice(end)));
    return pre;
  }
  function responseText(completion) {
    let formatted;
    // Existing checks contain an outcome, not a parsed value. Never retry a known
    // parse failure; parse the exact saved text for presentation on success/absence.
    if (!completion.checks?.parse?.startsWith("Fail")) {
      try { formatted = JSON.stringify(JSON.parse(completion.text), null, 2); }
      catch { /* Keep original text if unavailable, malformed, or redacted. */ }
    }
    if (formatted === undefined) return element("pre", "", completion.text);
    const container = element("div", "response-text"), controls = element("div", "json-display-controls");
    controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "JSON display");
    const formattedButton = element("button", "", "Formatted"), originalButton = element("button", "", "Original");
    const content = element("div", "json-display-content");
    function display(original) {
      formattedButton.setAttribute("aria-pressed", String(!original));
      originalButton.setAttribute("aria-pressed", String(original));
      content.replaceChildren(original ? element("pre", "", completion.text) : highlightedJSON(formatted));
    }
    formattedButton.type = originalButton.type = "button";
    formattedButton.addEventListener("click", () => display(false));
    originalButton.addEventListener("click", () => display(true));
    controls.append(formattedButton, originalButton); container.append(controls, content);
    display(completion.truncated);
    return container;
  }
  function showResponse(entry) {
    const panel = $("response-panel"); panel.replaceChildren();
    if (!entry) { panel.append(element("p", "empty", "Generated text and output checks will appear here.")); return; }
    if (entry.pending) { panel.append(element("p", "empty", "Waiting for the API…")); return; }
    for (const completion of entry.completions || []) {
      const section = element("section", "completion");
      if (entry.completions.length > 1) section.append(element("h3", "", `Completion ${completion.index + 1}`));
      if (completion.text !== null) section.append(responseText(completion));
      else section.append(element("p", "hint", "No generated text. See the summary above and Raw JSON for details."));
      panel.append(section);
    }
  }
  function showSummary(entry) {
    const summary = $("detail-summary"); summary.replaceChildren();
    summary.hidden = !entry || entry.pending;
    if (summary.hidden) return;
    if (entry.error) summary.append(element("pre", "error", entry.error));
    if (!entry.completions?.length) {
      summary.append(element("p", "hint", "finish_reason: unavailable · JSON parsing: Not performed — no assistant content."));
      summary.append(element("p", "hint", entry.snapshot.format?.type === "json_schema" ? "Schema validation: Not performed — no assistant content." : "Schema validation: Not requested (no JSON Schema submitted)."));
    }
    for (const completion of entry.completions || []) {
      const section = element("section", "completion-summary");
      if (entry.completions.length > 1) section.append(element("h3", "", `Completion ${completion.index + 1}`));
      if (completion.state !== "Complete") section.append(element("p", "completion-status error", `${completion.state} · completion reason: ${completion.reason}`));
      if (completion.truncated) section.append(element("p", "error", "Warning: the token limit interrupted this answer. Generated text may be partial, even if JSON parsing or schema validation passes."));
      if (completion.error) section.append(element("pre", "error", completion.error));
      if (completion.refusal) section.append(element("pre", "error", `Refusal: ${completion.refusal}`));
      const checks = element("div", "checks");
      if (completion.checks.formatStatus) checks.append(element("p", completion.checks.formatError ? "error" : completion.checks.formatStatus === "Format valid" ? "success" : "hint", completion.checks.formatStatus === "Format valid" ? "Format valid — structure only; factual correctness and completeness are not verified." : completion.checks.formatStatus));
      checks.append(element("p", "", `JSON parsing: ${completion.checks.parse}`));
      checks.append(element("p", "", `Schema validation: ${completion.checks.schema}`));
      section.append(checks); summary.append(section);
    }
  }
  function render() {
    renderHistory();
    const entry = history.find(item => item.id === selected);
    $("detail-title").textContent = entry ? entry.snapshot.prompt : "Explore your first response";
    $("detail-status").className = `detail-status ${entry?.failed ? "error" : ""}`;
    $("detail-status").textContent = !entry ? "Send a prompt to begin." : entry.pending ? "Sending…" : `${entry.status ? `HTTP ${entry.status} ${entry.statusText}` : "Request failed"} · ${(entry.duration / 1000).toFixed(2)} s${entry.completionStatus ? ` · ${entry.completionStatus}` : ""}${entry.formatStatus ? ` · ${entry.formatStatus}` : ""}`;
    $("detail-meta").textContent = entry ? `${entry.snapshot.provider} · ${entry.snapshot.model} · ${new Date(entry.timestamp).toLocaleString()}` : "";
    $("request-endpoint").textContent = entry ? `POST ${entry.snapshot.endpoint}` : "";
    $("request-content").replaceChildren(entry ? highlightedJSON(JSON.stringify(entry.snapshot.body, null, 2)) : element("pre", "", "No request selected."));
    $("raw-content").replaceChildren(entry && !entry.pending && entry.json ? highlightedJSON(JSON.stringify(entry.raw, null, 2)) : element("pre", "", !entry ? "No response selected." : entry.pending ? "Waiting for the API…" : entry.raw === null ? "No response body available." : `Non-JSON response body:\n\n${entry.raw}`));
    showSummary(entry); showResponse(entry); buttons();
  }
  function formMessage(text = "") { $("form-message").textContent = text; $("form-message").hidden = !text; }
  $("explorer-form").addEventListener("submit", async event => {
    event.preventDefault();
    if ($("send").disabled) return;
    formMessage();
    const controls = readRows();
    if (controls.errors.size) { formMessage(controls.errors.get(-1) || "Fix the marked parameter rows before sending."); return; }
    const credential = key.value.trim(), requestModel = model.value.trim(), requestPrompt = prompt.value;
    let body;
    const current = adapter(), requestProvider = providerId, endpoint = current.endpoint(requestModel);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(requestModel)) { formMessage("Use a model ID containing letters, numbers, dots, underscores, colons, or hyphens; omit URL paths."); return; }
    try { body = current.body(requestModel, requestPrompt, controls.values); }
    catch { formMessage("The request is too large or deeply nested to snapshot safely. Simplify the parameter values."); return; }
    if (JSON.stringify(C.redact(body, credential)) !== JSON.stringify(body)) { formMessage("Remove credentials or secret-like text from the model, prompt, and parameters before sending. Use only the API Key field."); return; }
    const entry = {
      id: nextId++, timestamp: new Date().toISOString(), pending: true, failed: false,
      snapshot: C.freeze({ providerId: requestProvider, provider: current.name, endpoint, prompt: requestPrompt, model: requestModel, parameters: C.clone(controls.values), body, format: C.clone(current.format(body) ?? null) }),
      status: null, statusText: "", duration: 0, raw: null, json: false, error: null, completions: null
    };
    history.unshift(entry); selected = entry.id; sending = true;
    selectTab("response"); render();
    const started = performance.now(), controller = new AbortController(), version = settingsVersion;
    requestController = controller;
    const result = await api(body, credential, controller, current, endpoint);
    entry.duration = performance.now() - started;
    entry.status = result.status; entry.statusText = C.redact(result.statusText, credential);
    entry.raw = C.redact(result.raw, credential); entry.json = result.json;
    entry.usage = C.redact(current.usage(result.raw), credential);
    entry.failed = !result.ok;
    if (!result.ok) {
      entry.error = C.redact(errorMessage(result, requestProvider), credential);
      if (result.status === 401 && version === settingsVersion) {
        resetVerification(); key.setAttribute("aria-invalid", "true");
        connectionMessage("Authentication failed. Check your API key and verify again.", "error");
      }
    } else {
      const outputs = result.json ? current.outputs(result.raw, entry.snapshot.format) : null;
      entry.error = result.json ? C.redact(C.explicitError(result.raw), credential) : null;
      if (!outputs) {
        entry.failed = true;
        entry.completionStatus = entry.error ? "API error" : "Malformed response";
        entry.error ||= "Unexpected API response: missing or malformed provider output. Inspect Raw JSON.";
      }
      else {
        entry.completions = C.redact(outputs, credential);
        const states = [...new Set(outputs.map(output => output.state).filter(state => state !== "Complete"))];
        entry.completionStatus = [...new Set([...(entry.error ? ["API error"] : []), ...states])].join(" · ");
        entry.formatStatus = [...new Set(outputs.map(output => output.checks.formatStatus).filter(Boolean))].join(" · ");
        entry.failed = Boolean(entry.error) || outputs.some(output => output.state !== "Complete" || output.error || output.checks.formatError);
      }
    }
    entry.pending = false; sending = false; requestController = null;
    render();
  });

  function selectTab(name) {
    for (const tab of ["response", "request", "raw"]) {
      $(tab + "-tab").setAttribute("aria-selected", String(name === tab));
      $(tab + "-tab").tabIndex = name === tab ? 0 : -1;
      $(tab + "-panel").hidden = name !== tab;
    }
  }
  const tabNames = ["response", "request", "raw"];
  for (const [index, name] of tabNames.entries()) {
    $(name + "-tab").addEventListener("click", () => selectTab(name));
    $(name + "-tab").addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % 3;
      if (event.key === "ArrowLeft") next = (index + 2) % 3;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = 2;
      if (next !== undefined) { event.preventDefault(); selectTab(tabNames[next]); $(tabNames[next] + "-tab").focus(); }
    });
  }
  key.addEventListener("input", resetVerification);
  model.addEventListener("input", () => { resetVerification(); updateProviderUI(); });
  $("model-choice").addEventListener("change", () => {
    const custom = $("model-choice").value === "custom";
    $("custom-model-field").hidden = !custom;
    model.value = custom ? "" : $("model-choice").value;
    resetVerification(); updateProviderUI(); if (custom) model.focus();
  });
  $("provider").addEventListener("change", () => {
    const next = $("provider").value;
    if (!P.presets[next]) { $("provider").value = providerId; return; }
    if (next === providerId) { resetVerification(); return; }
    if (JSON.stringify(rowData()) !== initialRows && !window.confirm("Switching providers replaces your edited parameter rows with that provider's defaults. The prompt and history are kept. Replace the rows?")) { $("provider").value = providerId; return; }
    providerId = next;
    key.value = ""; key.type = "password";
    $("key-visibility").setAttribute("aria-pressed", "false"); $("key-visibility").setAttribute("aria-label", "Show API key");
    populateModels(); populateRows(); resetVerification(); formMessage();
  });
  prompt.addEventListener("input", buttons);
  $("key-visibility").addEventListener("click", () => {
    const visible = key.type === "password"; key.type = visible ? "text" : "password";
    $("key-visibility").setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
    $("key-visibility").setAttribute("aria-pressed", String(visible));
  });
  $("add-row").addEventListener("click", () => addRow().querySelector(".row-key").focus());
  $("clear").addEventListener("click", () => { if (sending) return; history.length = 0; selected = null; render(); });
  function leave() { settingsVersion++; verifyController?.abort(); requestController?.abort(); key.value = ""; key.type = "password"; }
  window.addEventListener("pagehide", leave);
  window.addEventListener("pageshow", event => { if (event.persisted) { history.length = 0; selected = null; sending = false; leave(); resetVerification(); render(); } });
  key.value = "";
  $("provider").value = providerId;
  populateModels(); populateRows();
  render();
})();
