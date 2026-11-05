"use strict";

const form = document.querySelector("#explorer");
const keyInput = document.querySelector("#api-key");
const keyVisibility = document.querySelector("#key-visibility");
keyVisibility.addEventListener("click", () => {
  const visible = keyInput.type === "password";
  keyInput.type = visible ? "text" : "password";
  keyVisibility.setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
  keyVisibility.setAttribute("aria-pressed", String(visible));
});
const question = document.querySelector("#question");
const send = document.querySelector("#send");
const feedback = document.querySelector("#feedback");
const status = document.querySelector("#status");
const check = document.querySelector("#key-check");
const answer = document.querySelector("#answer");
const hint = document.querySelector("#answer-hint");
const json = document.querySelector("#json");
const tabs = [...document.querySelectorAll('[role="tab"]')];
let activeRequest = null;
let keyVerified = false;
let verificationTimer = null;
let verificationRequest = null;
let verificationVersion = 0;
const verificationFailure = "Could not verify API key. Check the key or try again later.";
send.disabled = true;

async function verifyKey(version) {
  if (version !== verificationVersion || !keyInput.value.trim()) return;
  let key = keyInput.value.trim();
  const controller = new AbortController();
  verificationRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);
  status.textContent = "Checking API key…";
  status.classList.add("checking");
  try {
    // Small authenticated metadata request; does not generate a response.
    const response = await fetch("https://api.openai.com/v1/models/gpt-5.4-mini", {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    });
    if (version !== verificationVersion) return;
    if (!response.ok) {
      showError(response.status === 401 ? httpError(401) : verificationFailure, response.status === 401);
      return;
    }
    keyVerified = true;
    check.hidden = false;
  } catch {
    if (version === verificationVersion) showError(verificationFailure);
  } finally {
    clearTimeout(timeout);
    key = "";
    if (version === verificationVersion) {
      verificationRequest = null;
      status.classList.remove("checking");
      status.textContent = keyVerified ? "API key verified." : "";
      send.disabled = !keyVerified || !!activeRequest;
    }
  }
}

function selectTab(selected) {
  tabs.forEach((tab) => {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = tabs[1 - index];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs[1];
    if (next) { event.preventDefault(); selectTab(next); next.focus(); }
  });
});

function showError(message, authentication = false) {
  feedback.textContent = message;
  feedback.hidden = false;
  keyInput.setAttribute("aria-invalid", String(authentication));
}

function httpError(code) {
  if (code === 401) return "Invalid API key. Check the key and try again.";
  if (code === 403) return "Access denied (HTTP 403). Check your project permissions and model access.";
  if (code === 429) return "Rate limit or quota exceeded (HTTP 429). Check your API usage and billing before retrying.";
  if (code === 408 || code === 504) return `The request timed out (HTTP ${code}). Try again later.`;
  if (code >= 500) return `OpenAI service error (HTTP ${code}). Try again later.`;
  if (code === 404) return "Resource unavailable (HTTP 404). Check model availability for your project.";
  return `Request rejected (HTTP ${code}). Check the request configuration and try again.`;
}

// Redact credentials even if a response unexpectedly echoes them.
function sanitize(value, key) {
  const redactText = (text) => text.split(key).join("[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      redactText(name),
      /authorization|api[-_]?key|credential|secret|access[-_]?token/i.test(name)
        ? "[REDACTED]" : sanitize(item, key)
    ]));
  }
  return value;
}

function extractAnswer(data) {
  if (!Array.isArray(data.output)) throw new Error("Unexpected response shape");
  return data.output.filter((item) => item.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
    .filter((text) => typeof text === "string" && text).join("\n\n");
}

function renderAnswer(text) {
  // Fail closed to plain text if a local library is missing or unsupported.
  answer.textContent = text;
  if (!window.marked || !window.DOMPurify?.isSupported) return;
  try {
    const html = window.marked.parse(text, { gfm: true, async: false });
    const clean = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
        "strong", "em", "del", "ul", "ol", "li", "blockquote", "a", "pre", "code",
        "table", "thead", "tbody", "tr", "th", "td"],
      ALLOWED_ATTR: ["href", "title", "start"],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true
    });
    answer.replaceChildren(clean);
  } catch {
    // Keep the safe plain-text response if Markdown rendering fails.
  }
}

keyInput.addEventListener("input", () => {
  verificationVersion += 1;
  clearTimeout(verificationTimer);
  verificationRequest?.abort();
  verificationRequest = null;
  keyVerified = false;
  send.disabled = true;
  check.hidden = true;
  keyInput.setAttribute("aria-invalid", "false");
  feedback.hidden = true;
  status.classList.remove("checking");
  status.textContent = "";
  if (keyInput.value.trim()) {
    const version = verificationVersion;
    verificationTimer = setTimeout(() => verifyKey(version), 600);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (activeRequest || !keyVerified) return;
  let key = keyInput.value.trim();
  const prompt = question.value.trim();
  if (!key || !prompt) {
    showError("Enter an API key and a question before sending.");
    (!key ? keyInput : question).focus();
    return;
  }
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);
  send.disabled = keyInput.disabled = question.disabled = true;
  feedback.hidden = true;
  check.hidden = true;
  keyInput.setAttribute("aria-invalid", "false");
  document.querySelector("#response").setAttribute("aria-busy", "true");
  answer.textContent = "Waiting for the response…";
  answer.parentElement.classList.remove("has-result");
  hint.hidden = true;
  json.textContent = "Waiting for the response…";
  status.textContent = "Sending request…";
  selectTab(tabs[0]);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-5.4-mini", input: prompt, store: false }),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    });
    if (!response.ok) {
      // Do not read or display provider error bodies; they may echo credentials.
      showError(httpError(response.status), response.status === 401);
      if (response.status === 401) keyVerified = false;
      answer.textContent = "No answer received.";
      json.textContent = JSON.stringify({ http_status: response.status, message: httpError(response.status) }, null, 2);
      status.textContent = "Request failed.";
      return;
    }
    let data;
    try {
      data = sanitize(await response.json(), key);
      if (!data || typeof data !== "object" || !Array.isArray(data.output)) throw new Error("Unexpected response");
    } catch {
      showError("OpenAI returned an unreadable or unexpected JSON response.");
      answer.textContent = "No answer received.";
      json.textContent = "No valid response JSON available.";
      status.textContent = "Request failed.";
      return;
    }
    renderAnswer(extractAnswer(data) || "No text answer was returned. See Raw JSON for response details.");
    answer.parentElement.classList.add("has-result");
    json.textContent = JSON.stringify(data, null, 2);
    check.hidden = !keyVerified;
    if (data.status === "incomplete") {
      showError("The response is incomplete. Any available text is shown below.");
    } else if (data.status === "failed" || data.error) {
      // Replace potentially sensitive failure details with a fixed message.
      answer.textContent = "No answer received.";
      json.textContent = JSON.stringify({ status: "failed", message: "The response could not be completed." }, null, 2);
      showError("OpenAI could not complete the response. Try again later.");
    }
    status.textContent = data.status === "completed" ? "Response received." : "Response received; check its status.";
  } catch (error) {
    const message = controller.signal.aborted
      ? "Request timed out after 60 seconds. Try again later."
      : error instanceof TypeError
        ? "Browser fetch failed; no readable HTTP status is available. Possible causes: CORS, connectivity, DNS/TLS, or browser blocking. Check the browser Network/Console error category without sharing credentials."
        : "The request could not be completed. Try again.";
    showError(message);
    answer.textContent = "No answer received.";
    json.textContent = "No readable API response available.";
    status.textContent = "Request failed.";
  } finally {
    clearTimeout(timeout);
    key = "";
    activeRequest = null;
    keyInput.disabled = question.disabled = false;
    send.disabled = !keyVerified;
    check.hidden = !keyVerified;
    document.querySelector("#response").setAttribute("aria-busy", "false");
  }
});

// Avoid retaining input values through back/forward cache navigation.
window.addEventListener("pagehide", () => {
  verificationVersion += 1;
  clearTimeout(verificationTimer);
  verificationRequest?.abort();
  verificationRequest = null;
  keyVerified = false;
  send.disabled = true;
  status.classList.remove("checking");
  activeRequest?.abort();
  keyInput.value = "";
  question.value = "";
  answer.textContent = "Your answer will appear here.";
  json.textContent = "No API response yet.";
  hint.hidden = false;
  check.hidden = true;
  feedback.hidden = true;
  status.textContent = "";
});
