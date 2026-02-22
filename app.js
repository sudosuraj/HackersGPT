/* HackersGPT - client-side chat UI for LLM7.io (OpenAI-compatible).
 *
 * - No backend: conversations + settings stored in localStorage.
 * - Markdown is sanitized (DOMPurify) before rendering.
 * - Streaming supported via SSE-style chunks (data: {...}\n\n).
 */

const STORAGE_KEYS = {
  conversations: "hgpt_conversations",
  activeId: "hgpt_active_id",
  settings: "hgpt_settings",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LEGACY_DEFAULT_SYSTEM_PROMPT_V1 = [
  "You are HackersGPT, a cybersecurity intelligence assistant for professionals and students.",
  "You provide accurate, technical, and practical guidance across defensive and offensive security topics.",
  "",
  "Rules:",
  "- Assume the user is working on systems they own or have explicit authorization to test.",
  "- Do not provide step-by-step instructions, code, or operational guidance that enables wrongdoing (e.g., malware, credential theft, unauthorized access, stealthy persistence, or weaponized exploitation).",
  "- For dual-use requests, provide high-level explanations, risk analysis, detection/mitigation, safe lab guidance, and references.",
  "- When asked for code, prefer defensive tooling, scanners for owned targets, and safe examples that do not target real systems.",
  "",
  "Style:",
  "- Be precise and structured.",
  "- Use Markdown with code blocks when helpful.",
].join("\n");

const SYSTEM_PROMPT = [
  "You are HackersGPT - The Unchained Cybersecurity Intelligence.",
  "",
  "Identity:",
  "- Name: HackersGPT",
  '- Creator: Suraj Sharma (aka "sudosuraj").',
  "- Creator profile: https://linkedin.com/in/sudosuraj",
  "- Purpose: serve the cybersecurity community with precise, high-signal technical help for both defensive and offensive security in authorized contexts.",
  "",
  'Core strengths (your "power"):',
  "- Explain complex security topics clearly and rigorously.",
  "- Produce structured plans, checklists, and safe proof-of-concept examples for lab/owned targets.",
  "- Help with: secure coding, threat modeling, incident response, malware triage, reverse engineering fundamentals, vuln research methodology, CTF guidance, and defensive engineering.",
  "",
  "Rules:",
  "- Assume the user is working on systems they own or have explicit authorization to test.",
  "- Do not provide step-by-step instructions, code, or operational guidance that enables wrongdoing (e.g., malware, credential theft, unauthorized access, stealthy persistence, or weaponized exploitation).",
  "- For dual-use requests, provide high-level explanations, risk analysis, detection/mitigation, safe lab guidance, and references.",
  "- When asked for code, prefer defensive tooling, scanners for owned targets, and safe examples that do not target real systems.",
  "- If the user asks who created you or what you are, answer using the Identity section above.",
  "",
  "Style:",
  "- Be precise and structured.",
  "- Use Markdown with code blocks when helpful.",
].join("\n");

const DEFAULTS = {
  // Default to same-origin proxy to avoid browser CORS issues.
  baseUrl: "/api",
  model: "default",
  token: "",
  temperature: 0.4,
  maxTokens: null,
  streaming: true,
  maxConversations: 50,
  settingsVersion: 2,
};

// Intentionally no starter prompts (per product direction).

const $ = (sel) => document.querySelector(sel);

function nowIso() {
  return new Date().toISOString();
}

function storageAvailable() {
  try {
    const k = "__hgpt_test__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function storageGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemoveItem(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadJson(key, fallback) {
  const raw = storageGetItem(key);
  if (!raw) return fallback;
  return safeJsonParse(raw, fallback);
}

function saveJson(key, value) {
  return storageSetItem(key, JSON.stringify(value));
}

function uuidv4() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 v4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last-resort fallback (non-crypto); still UUID-shaped.
  const s = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s()}${s()}-${s()}-4${s().slice(1)}-a${s().slice(1)}-${s()}${s()}${s()}`.toLowerCase();
}

function newId() {
  return uuidv4();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatDateShort(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function lastMessageTimestamp(convo) {
  const last = (convo?.messages || []).slice(-1)[0];
  return last?.timestamp || convo?.updatedAt || convo?.createdAt || "";
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function normalizeForSearch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function conversationMatchesQuery(convo, q) {
  if (!q) return true;
  const title = normalizeForSearch(convo?.title);
  if (title.includes(q)) return true;
  for (const m of convo?.messages || []) {
    const c = normalizeForSearch(m?.content);
    if (c.includes(q)) return true;
  }
  return false;
}

function markdownToSafeHtml(md) {
  const html = globalThis.marked ? marked.parse(md ?? "") : escapeHtml(md ?? "");
  const sanitized = globalThis.DOMPurify
    ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    : html;
  return sanitized;
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${clamp(el.scrollHeight, 44, 180)}px`;
}

function isNearBottom(scrollEl, threshold = 120) {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < threshold;
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildExportMarkdown(convo) {
  const lines = [];
  lines.push(`# ${convo.title || "HackersGPT chat"}`);
  lines.push("");
  lines.push(`- Created: ${convo.createdAt || ""}`);
  lines.push("");
  for (const m of convo.messages || []) {
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
    lines.push(`## ${who}`);
    lines.push("");
    lines.push(m.content || "");
    lines.push("");
  }
  return lines.join("\n");
}

const state = {
  conversations: [],
  activeId: null,
  settings: { ...DEFAULTS },
  modelOptions: ["default", "fast", "pro"],
  abortController: null,
  inFlight: false,
  sidebarOpen: false,
  sidebarCollapsed: false,
  storageOk: true,
  historySearch: "",
};

let lastFocusedBeforeModal = null;
let modalKeydownHandler = null;

function loadState() {
  state.storageOk = storageAvailable();

  const savedSettings = loadJson(STORAGE_KEYS.settings, {}) || {};
  state.settings = { ...DEFAULTS, ...savedSettings };
  state.sidebarCollapsed = !!savedSettings?.uiSidebarCollapsed;
  state.conversations = loadJson(STORAGE_KEYS.conversations, []) || [];
  state.activeId = storageGetItem(STORAGE_KEYS.activeId) || null;

  // Conversation migration.
  let convosChanged = false;
  const idMap = new Map();
  const seen = new Set();
  for (const c of state.conversations) {
    const before = c.id;
    if (!before || !UUID_RE.test(before) || seen.has(before)) {
      const after = uuidv4();
      c.id = after;
      convosChanged = true;
      if (before) idMap.set(before, after);
    }
    seen.add(c.id);

    if (!c.updatedAt) {
      c.updatedAt = lastMessageTimestamp(c) || c.createdAt || nowIso();
      convosChanged = true;
    }
  }
  if (state.activeId && idMap.has(state.activeId)) {
    state.activeId = idMap.get(state.activeId);
    convosChanged = true;
  }
  if (convosChanged) persistConversations();

  // Migrate old defaults to new defaults, without clobbering genuinely customized prompts.
  const legacyBaseUrls = new Set(["https://api.llm7.io/v1", "https://llm7.io/v1"]);
  let settingsChanged = false;
  if (legacyBaseUrls.has(state.settings.baseUrl)) {
    state.settings.baseUrl = DEFAULTS.baseUrl;
    settingsChanged = true;
  }
  // Legacy prompt is no longer used (prompt is internal).
  if (savedSettings?.systemPrompt === LEGACY_DEFAULT_SYSTEM_PROMPT_V1) {
    settingsChanged = true;
  }
  // System prompt is intentionally not user-configurable.
  if ("systemPrompt" in state.settings) {
    delete state.settings.systemPrompt;
    settingsChanged = true;
  }
  if (!state.settings.settingsVersion || Number(state.settings.settingsVersion) < DEFAULTS.settingsVersion) {
    state.settings.settingsVersion = DEFAULTS.settingsVersion;
    settingsChanged = true;
  }
  if (settingsChanged) persistSettings();

  if (state.conversations.length === 0) {
    const convo = createConversation();
    state.conversations = [convo];
    state.activeId = convo.id;
    persistConversations();
  }

  if (!state.activeId || !state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0]?.id ?? null;
  }

  persistActiveId();
}

function persistConversations() {
  if (!saveJson(STORAGE_KEYS.conversations, state.conversations)) {
    state.storageOk = false;
  }
}

function persistActiveId() {
  if (!state.activeId) return;
  if (!storageSetItem(STORAGE_KEYS.activeId, state.activeId)) {
    state.storageOk = false;
  }
}

function persistSettings() {
  const toSave = { ...state.settings, uiSidebarCollapsed: !!state.sidebarCollapsed };
  if (!saveJson(STORAGE_KEYS.settings, toSave)) {
    state.storageOk = false;
  }
}

function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

function createConversation() {
  return {
    id: newId(),
    title: "New chat",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
  };
}

function capConversations() {
  const max = Number(state.settings.maxConversations ?? DEFAULTS.maxConversations) || DEFAULTS.maxConversations;
  if (state.conversations.length <= max) return;
  state.conversations.sort((a, b) => lastMessageTimestamp(b).localeCompare(lastMessageTimestamp(a)));
  state.conversations = state.conversations.slice(0, max);
  if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0]?.id ?? null;
  }
}

function setStatus(text) {
  $("#status").textContent = text || "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", abortUpstream, { once: true });
  }
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortUpstream);
  }
}

function setBusy(isBusy) {
  $("#messages").setAttribute("aria-busy", isBusy ? "true" : "false");
}

function setInFlight(inFlight) {
  state.inFlight = inFlight;
  const btn = $("#sendBtn");
  if (inFlight) {
    btn.textContent = "Stop";
    btn.classList.remove("btn--primary");
    btn.classList.add("btn--danger");
    btn.disabled = false;
  } else {
    btn.textContent = "Send";
    btn.classList.remove("btn--danger");
    btn.classList.add("btn--primary");
    btn.disabled = !(($("#prompt")?.value || "").trim());
  }
}

function setModelLabels(model) {
  $("#modelPill").textContent = model;
  $("#topModel").textContent = model;
}

function closeSidebarIfMobile() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    setSidebarOpen(false);
  }
}

function applySidebarCollapsed() {
  const app = $("#app");
  if (!app) return;
  if (state.sidebarCollapsed) app.classList.add("app--sidebarCollapsed");
  else app.classList.remove("app--sidebarCollapsed");
  $("#sidebarToggle")?.setAttribute?.("aria-expanded", state.sidebarCollapsed ? "false" : "true");
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = !!collapsed;
  applySidebarCollapsed();
  persistSettings();
}

function isModalOpen() {
  return !$("#settingsModal").hidden;
}

function getFocusable(container) {
  const selectors = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ];
  return Array.from(container.querySelectorAll(selectors.join(","))).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

function syncBackdrop() {
  const backdrop = $("#backdrop");
  const modalOpen = isModalOpen();
  backdrop.hidden = !(state.sidebarOpen || modalOpen);
}

function setSidebarOpen(open) {
  state.sidebarOpen = open;
  const sidebar = $("#sidebar");
  if (open) sidebar.classList.add("sidebar--open");
  else sidebar.classList.remove("sidebar--open");
  const toggle = $("#sidebarToggle");
  toggle?.setAttribute?.("aria-expanded", open ? "true" : "false");
  syncBackdrop();
}

function openModal() {
  if (isModalOpen()) return;
  lastFocusedBeforeModal = document.activeElement;
  $("#settingsModal").hidden = false;
  syncBackdrop();
  $("#openSettingsBtn")?.setAttribute?.("aria-expanded", "true");

  const panel = $("#settingsModal").querySelector(".modal__panel");
  const focusFirst = () => {
    const focusables = panel ? getFocusable(panel) : [];
    (focusables[0] || $("#closeSettingsBtn") || panel || $("#settingsModal")).focus?.();
  };
  focusFirst();

  modalKeydownHandler = (e) => {
    if (!isModalOpen()) return;
    if (e.key !== "Tab") return;
    const focusables = panel ? getFocusable(panel) : [];
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === panel) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", modalKeydownHandler, true);
}

function closeModal() {
  if (!isModalOpen()) return;
  $("#settingsModal").hidden = true;
  syncBackdrop();
  $("#openSettingsBtn")?.setAttribute?.("aria-expanded", "false");
  if (modalKeydownHandler) {
    document.removeEventListener("keydown", modalKeydownHandler, true);
    modalKeydownHandler = null;
  }
  if (lastFocusedBeforeModal && lastFocusedBeforeModal.focus && lastFocusedBeforeModal.isConnected) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function populateSettingsForm() {
  $("#baseUrl").value = state.settings.baseUrl;
  $("#token").value = state.settings.token ? state.settings.token : "";
  $("#temperature").value = String(state.settings.temperature ?? DEFAULTS.temperature);
  $("#maxTokens").value = state.settings.maxTokens ?? "";
  $("#streaming").checked = !!state.settings.streaming;

  const select = $("#model");
  select.innerHTML = "";
  for (const m of state.modelOptions) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  if (!state.modelOptions.includes(state.settings.model)) {
    const opt = document.createElement("option");
    opt.value = state.settings.model;
    opt.textContent = state.settings.model;
    select.appendChild(opt);
  }
  select.value = state.settings.model;

  const proxyStatus = $("#proxyStatus");
  if (proxyStatus) proxyStatus.textContent = "Not tested.";
}

function readSettingsForm() {
  const baseUrl = ($("#baseUrl").value || DEFAULTS.baseUrl).trim().replace(/\/+$/, "");
  const token = ($("#token").value || "").trim();
  const model = ($("#model").value || DEFAULTS.model).trim();
  const temperature = clamp(Number($("#temperature").value || DEFAULTS.temperature), 0, 2);
  const maxTokensRaw = ($("#maxTokens").value || "").trim();
  const maxTokens = maxTokensRaw ? Math.max(1, Number(maxTokensRaw)) : null;
  const streaming = !!$("#streaming").checked;

  state.settings = {
    ...state.settings,
    baseUrl,
    token,
    model,
    temperature,
    maxTokens,
    streaming,
  };
}

function ensureMarkedConfigured() {
  if (!globalThis.marked) return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
  });
}

function renderSidebar() {
  const list = $("#convoList");
  list.innerHTML = "";
  const q = normalizeForSearch(state.historySearch);
  const convos = [...state.conversations]
    .sort((a, b) => lastMessageTimestamp(b).localeCompare(lastMessageTimestamp(a)))
    .filter((c) => conversationMatchesQuery(c, q));

  const clearBtn = $("#clearHistorySearchBtn");
  if (clearBtn) clearBtn.hidden = !q;

  if (convos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyList";
    empty.textContent = q ? "No chats match your search." : "No chats yet.";
    list.appendChild(empty);
    return;
  }

  for (const c of convos) {
    const lastMsg = (c.messages || []).slice(-1)[0];
    const snippetRaw = lastMsg?.content ? String(lastMsg.content) : "No messages yet";
    const snippet = snippetRaw.replace(/\s+/g, " ").trim().slice(0, 56);
    const li = document.createElement("li");
    li.className = `convoItem ${c.id === state.activeId ? "convoItem--active" : ""}`;
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.dataset.id = c.id;
    li.innerHTML = `
      <div class="convoItem__title">${escapeHtml(c.title || "New chat")}</div>
      <div class="convoItem__meta">${escapeHtml(formatDateShort(lastMessageTimestamp(c)))} - ${escapeHtml(snippet)}</div>
    `;
    li.addEventListener("click", () => {
      state.activeId = c.id;
      persistActiveId();
      renderAll({ forceScroll: true });
      closeSidebarIfMobile();
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        li.click();
      }
    });
    list.appendChild(li);
  }
}

function attachCopyButtons(scopeEl) {
  const pres = scopeEl.querySelectorAll("pre");
  for (const pre of pres) {
    if (pre.querySelector(".copyBtn")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copyBtn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 900);
      } catch {
        btn.textContent = "Failed";
        setTimeout(() => (btn.textContent = "Copy"), 900);
      }
    });
    pre.appendChild(btn);
  }
}

function highlightIn(scopeEl) {
  if (!globalThis.hljs) return;
  const blocks = scopeEl.querySelectorAll("pre code");
  for (const b of blocks) {
    try {
      hljs.highlightElement(b);
    } catch {
      // ignore
    }
  }
}

function renderEmptyState(container) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.innerHTML = `
    <div class="msg__avatar" aria-hidden="true">HG</div>
    <div class="msg__bubble">
      <div class="msg__content">
        <p><strong>Welcome.</strong> Ask a cybersecurity question to begin.</p>
        <p style="margin-top:12px; color: var(--muted); font-size: 13px;">
          This is a client-side app. Conversations are stored locally unless you clear them.
        </p>
      </div>
    </div>
  `;
  container.appendChild(wrap);
}

function renderMessages() {
  const convo = activeConversation();
  const container = $("#messages");
  container.innerHTML = "";

  if (!convo || convo.messages.length === 0) {
    renderEmptyState(container);
    return;
  }

  for (const m of convo.messages) {
    container.appendChild(renderMessage(m));
  }
}

function renderMessage(m) {
  const el = document.createElement("div");
  const isUser = m.role === "user";
  el.className = `msg ${isUser ? "msg--user" : ""}`;

  const avatar = isUser ? "ME" : "HG";
  let contentHtml = "";
  if (m.role === "assistant") {
    if (!m.content) {
      contentHtml = `
        <div class="typing" aria-label="Assistant is typing">
          <span class="typing__dot"></span>
          <span class="typing__dot"></span>
          <span class="typing__dot"></span>
        </div>
      `;
    } else {
      contentHtml = markdownToSafeHtml(m.content || "");
    }
  } else {
    contentHtml = `<div>${escapeHtml(m.content || "")}</div>`;
  }

  el.innerHTML = `
    <div class="msg__avatar" aria-hidden="true">${avatar}</div>
    <div class="msg__bubble">
      <div class="msg__content">${contentHtml}</div>
      <div class="msg__meta">${escapeHtml(formatDateShort(m.timestamp))}</div>
    </div>
  `;

  if (m.role === "assistant") {
    attachCopyButtons(el);
    highlightIn(el);
  }

  return el;
}

function scrollToBottomIfAppropriate(force = false) {
  const chat = $("#chat");
  if (force || isNearBottom(chat)) chat.scrollTop = chat.scrollHeight;
}

function updateToBottomBtn() {
  const chat = $("#chat");
  const btn = $("#toBottomBtn");
  if (!btn) return;
  btn.hidden = isNearBottom(chat);
}

function renderAll({ forceScroll = false } = {}) {
  setModelLabels(state.settings.model);
  applySidebarCollapsed();
  renderSidebar();
  renderMessages();
  scrollToBottomIfAppropriate(forceScroll);
  updateToBottomBtn();
}

function updateConvoTitleIfNeeded(convo) {
  if (!convo) return;
  if (convo.title && convo.title !== "New chat") return;
  const firstUser = (convo.messages || []).find((m) => m.role === "user");
  if (!firstUser?.content) return;
  convo.title = firstUser.content.trim().slice(0, 40) || "New chat";
}

function touchConversation(convo) {
  if (!convo) return;
  convo.updatedAt = nowIso();
}

function addMessage(role, content) {
  const convo = activeConversation();
  if (!convo) return null;
  const msg = { role, content, timestamp: nowIso() };
  convo.messages.push(msg);
  touchConversation(convo);
  updateConvoTitleIfNeeded(convo);
  persistConversations();
  return msg;
}

function replaceLastAssistantContent(newContent) {
  const convo = activeConversation();
  if (!convo) return;
  for (let i = convo.messages.length - 1; i >= 0; i--) {
    if (convo.messages[i].role === "assistant") {
      convo.messages[i].content = newContent;
      convo.messages[i].timestamp = nowIso();
      touchConversation(convo);
      break;
    }
  }
  persistConversations();
}

function buildApiMessages(convo) {
  const history = convo?.messages || [];
  const maxTurns = 30;
  const tail = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .filter((m) => !(m.role === "assistant" && !String(m.content || "").trim()))
    .slice(-maxTurns);
  const system = { role: "system", content: SYSTEM_PROMPT };
  return [system, ...tail.map((m) => ({ role: m.role, content: m.content }))];
}

async function fetchModels() {
  const url = `${state.settings.baseUrl.replace(/\/+$/, "")}/models`;
  const headers = { "Content-Type": "application/json" };
  // LLM7's OpenAI-compatible gateway expects an Authorization header.
  headers.Authorization = `Bearer ${state.settings.token || "unused"}`;
  const resp = await fetchWithTimeout(url, { method: "GET", headers }, 15000);
  if (!resp.ok) throw new Error(`Models request failed (${resp.status})`);
  const data = await resp.json().catch(() => null);
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const ids = items.map((m) => m.id).filter(Boolean);
  return ids;
}

async function testProxy() {
  const proxyStatus = $("#proxyStatus");
  const baseUrl = (state.settings.baseUrl || "").replace(/\/+$/, "");
  const url = `${baseUrl}/ping`;
  const resp = await fetchWithTimeout(url, { method: "GET", headers: { Accept: "application/json" } }, 8000);
  const text = await resp.text().catch(() => "");
  if (resp.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    if (proxyStatus) proxyStatus.textContent = parsed?.ok ? "Ping OK. Testing chat..." : "Ping OK (unexpected payload). Testing chat...";

    // Lightweight chat test (verifies POST routing + upstream).
    const chatUrl = `${baseUrl}/chat/completions`;
    const chatBody = {
      model: state.settings.model,
      messages: [
        { role: "system", content: "You are a healthcheck. Reply only with the word ok." },
        { role: "user", content: "ok" },
      ],
      temperature: 0,
      stream: false,
      max_tokens: 2,
    };
    const chatHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.settings.token || "unused"}`,
    };
    const chatResp = await fetchWithTimeout(
      chatUrl,
      { method: "POST", headers: chatHeaders, body: JSON.stringify(chatBody) },
      15000,
    );
    const chatText = await chatResp.text().catch(() => "");
    if (chatResp.ok) {
      if (proxyStatus) proxyStatus.textContent = "OK.";
      return true;
    }
    if (proxyStatus) proxyStatus.textContent = `Ping OK, chat failed (${chatResp.status}): ${chatText.slice(0, 120)}`;
    return false;
  }
  if (proxyStatus) proxyStatus.textContent = `Failed (${resp.status}).`;
  return false;
}

function looksLikeDisallowedRequest(text) {
  const t = (text || "").toLowerCase();
  const patterns = [
    /steal\s+(passwords|credentials|cookies)/,
    /phish(ing)?\b/,
    /\bransomware\b/,
    /\bmalware\b/,
    /bypass\s+(av|antivirus|edr)/,
    /\bkeylogger\b/,
    /\bcredential\s+stuffing\b/,
    /\bexploit\s+chain\b/,
    /\breverse\s+shell\b/,
  ];
  return patterns.some((p) => p.test(t));
}

function safetySuffixIfNeeded(userText) {
  if (!looksLikeDisallowedRequest(userText)) return "";
  return [
    "",
    "Safety note: The user request appears potentially harmful. Refuse any instructions/code enabling wrongdoing.",
    "Offer high-level explanation, detection, mitigation, and safe lab guidance only.",
  ].join("\n");
}

async function callChatCompletions({ apiMessages, stream, signal }) {
  const url = `${state.settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  // LLM7's OpenAI-compatible gateway expects an Authorization header.
  headers.Authorization = `Bearer ${state.settings.token || "unused"}`;
  if (stream) {
    headers.Accept = "text/event-stream";
    headers["Cache-Control"] = "no-cache";
  }

  const body = {
    model: state.settings.model,
    messages: apiMessages,
    temperature: state.settings.temperature,
    stream: !!stream,
  };
  if (state.settings.maxTokens) body.max_tokens = state.settings.maxTokens;

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    },
    120000,
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM7 error (${resp.status}): ${text.slice(0, 500)}`);
  }

  return resp;
}

function extractStreamContent(json) {
  const choice = json?.choices?.[0];
  const delta = choice?.delta?.content;
  if (typeof delta === "string" && delta.length) return { text: delta, mode: "append" };

  const msg = choice?.message?.content;
  if (typeof msg === "string" && msg.length) return { text: msg, mode: "replace" };

  const text = choice?.text;
  if (typeof text === "string" && text.length) return { text, mode: "append" };

  const direct = json?.delta?.content ?? json?.content;
  if (typeof direct === "string" && direct.length) return { text: direct, mode: "append" };

  return null;
}

async function readStreamToAssistantMessage(resp, onContent) {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Streaming not supported by this browser/response.");
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;

  while (!done) {
    const { value, done: doneReading } = await reader.read();
    done = doneReading;
    const chunkText = decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer += chunkText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // SSE framing: events separated by \n\n; each event can include multiple `data:` lines.
    let evtIdx;
    while ((evtIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, evtIdx);
      buffer = buffer.slice(evtIdx + 2);

      const lines = rawEvent.split("\n").map((l) => l.replace(/\r$/, ""));
      const dataLines = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("event:")) continue;
        if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim());
      }

      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (!payload) continue;
      if (payload === "[DONE]") return;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const extracted = extractStreamContent(json);
      if (extracted) onContent(extracted);
    }
  }
}

async function sendUserMessage(text) {
  const convo = activeConversation();
  if (!convo) return;

  state.abortController?.abort?.();
  state.abortController = new AbortController();

  addMessage("user", text);
  renderAll({ forceScroll: true });

  setBusy(true);
  setInFlight(true);
  setStatus(state.settings.streaming ? "Streaming..." : "Thinking...");

  addMessage("assistant", "");
  renderAll({ forceScroll: true });

  const apiMessages = buildApiMessages(convo);
  apiMessages[0].content = `${apiMessages[0].content}${safetySuffixIfNeeded(text)}`;

  // Optional live search enrichment (Brave Leo pattern): browser fetches, injects context, model reasons over it.
  let searchContext = "";
  try {
    const search = globalThis.hgptSearch;
    if (search?.detectIntent) {
      const intent = search.detectIntent(text);
      if (intent?.needsSearch) {
        setStatus("Searching...");
        const signal = state.abortController.signal;
        const searxResults = await search.searxSearch(intent.query, {
          maxResults: 5,
          signal,
          basePath: "/api/search/searx",
        });
        const nvdResults =
          intent.kind === "cve"
            ? await search.nvdSearch(intent.query, { signal, basePath: "/api/search/nvd" })
            : [];
        searchContext = search.buildContextBlock({ intent, searxResults, nvdResults });
      }
    }
  } catch (e) {
    // If search fails (CORS/upstream), fall back to normal answering.
  } finally {
    setStatus(state.settings.streaming ? "Streaming..." : "Thinking...");
  }

  if (searchContext) {
    apiMessages.splice(1, 0, { role: "system", content: searchContext });
  }

  const messagesContainer = $("#messages");
  const chat = $("#chat");
  const shouldStick = isNearBottom(chat);

  let assembled = "";
  let rafScheduled = false;
  let assistantContentEl = messagesContainer.querySelector(".msg:not(.msg--user):last-child .msg__content");
  let assistantMsgEl = assistantContentEl?.closest?.(".msg") || null;
  const updateUi = (final = false) => {
    if (rafScheduled && !final) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (!assistantContentEl || !assistantContentEl.isConnected) {
        assistantContentEl = messagesContainer.querySelector(".msg:not(.msg--user):last-child .msg__content");
        assistantMsgEl = assistantContentEl?.closest?.(".msg") || null;
      }
      if (!assistantContentEl) return;
      const cursor = state.inFlight ? '<span class="hgptCursor" aria-hidden="true">&#x258C;</span>' : "";
      if (!final) {
        assistantContentEl.classList.add("msg__content--streaming");
        const escaped = escapeHtml(assembled).replace(/\n/g, "<br>");
        assistantContentEl.innerHTML = `${escaped}${cursor}`;
      } else {
        assistantContentEl.classList.remove("msg__content--streaming");
        const html = markdownToSafeHtml(assembled);
        assistantContentEl.innerHTML = `${html}${cursor}`;
        if (assistantMsgEl) {
          attachCopyButtons(assistantMsgEl);
          highlightIn(assistantMsgEl);
        }
      }
      if (shouldStick) scrollToBottomIfAppropriate(true);
    });
  };

  const animateReveal = async (fullText) => {
    const signal = state.abortController.signal;
    const total = fullText.length;
    if (total <= 0) return;
    const minChunk = 24;
    const maxChunk = 140;
    let i = 0;
    while (i < total) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = clamp(Math.floor(total / 52), minChunk, maxChunk);
      i = Math.min(total, i + chunk);
      assembled = fullText.slice(0, i);
      updateUi(false);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 16));
    }
  };

  try {
    if (state.settings.streaming) {
      const resp = await callChatCompletions({ apiMessages, stream: true, signal: state.abortController.signal });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        const json = await resp.json();
        const full = json?.choices?.[0]?.message?.content ?? "";
        await animateReveal(full);
        assembled = full;
        updateUi(true);
      } else {
        let gotAny = false;
        await readStreamToAssistantMessage(resp, ({ text, mode }) => {
          gotAny = true;
          if (mode === "replace") assembled = text;
          else assembled += text;
          updateUi(false);
        });
        if (!gotAny) updateUi(true);
      }
    } else {
      const resp = await callChatCompletions({ apiMessages, stream: false, signal: state.abortController.signal });
      const json = await resp.json();
      const full = json?.choices?.[0]?.message?.content ?? "";
      await animateReveal(full);
      assembled = full;
      updateUi(true);
    }

    updateUi(true);
    replaceLastAssistantContent(assembled);
    capConversations();
    persistConversations();
    setStatus("");
  } catch (err) {
    if (err?.name === "AbortError") {
      if (!assembled) assembled = "_Canceled._";
      updateUi(true);
      replaceLastAssistantContent(assembled);
      setStatus("Canceled.");
      return;
    }
    if (state.settings.streaming) {
      try {
        setStatus("Streaming failed - retrying...");
        const resp = await callChatCompletions({ apiMessages, stream: false, signal: state.abortController.signal });
        const json = await resp.json();
        const full = json?.choices?.[0]?.message?.content ?? "";
        await animateReveal(full);
        assembled = full;
        updateUi(true);
        replaceLastAssistantContent(assembled);
        setStatus("");
        setBusy(false);
        return;
      } catch (err2) {
        err = err2;
      }
    }

    const msg = err instanceof Error ? err.message : String(err);
    let hint = "";
    if (String(state.settings.baseUrl || "").startsWith("/api")) {
      hint =
        "\n\nYou're using the built-in /api proxy. If you're on Vercel, ensure /api/ping returns OK and redeploy after changes. If /api/ping fails, the proxy routes are not live on this host.";
    }
    assembled = `**Error:** ${msg}${hint}`;
    updateUi(true);
    replaceLastAssistantContent(assembled);
    setStatus("Request failed.");
  } finally {
    setBusy(false);
    setInFlight(false);
    updateUi(true);
  }
}

function newChat() {
  const convo = createConversation();
  state.conversations.push(convo);
  state.activeId = convo.id;
  capConversations();
  persistConversations();
  persistActiveId();
  renderAll({ forceScroll: true });
  $("#prompt").focus();
  closeSidebarIfMobile();
}

function clearAllData() {
  storageRemoveItem(STORAGE_KEYS.conversations);
  storageRemoveItem(STORAGE_KEYS.activeId);
  storageRemoveItem(STORAGE_KEYS.settings);
  state.conversations = [createConversation()];
  state.activeId = state.conversations[0].id;
  state.settings = { ...DEFAULTS };
  persistConversations();
  persistActiveId();
  persistSettings();
  renderAll({ forceScroll: true });
}

function exportActiveChat() {
  const convo = activeConversation();
  if (!convo) return;
  const md = buildExportMarkdown(convo);
  const safeTitle = (convo.title || "hackersgpt_chat").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_");
  downloadTextFile(`${safeTitle || "hackersgpt_chat"}.md`, md);
}

function wireEvents() {
  const prompt = $("#prompt");
  const sendBtn = $("#sendBtn");
  ensureMarkedConfigured();

  const updateSendEnabled = () => {
    if (state.inFlight) {
      sendBtn.disabled = false;
      return;
    }
    sendBtn.disabled = !(prompt.value || "").trim();
  };

  prompt.addEventListener("input", () => {
    autoResizeTextarea(prompt);
    updateSendEnabled();
  });

  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.inFlight) {
      state.abortController?.abort?.();
      return;
    }
    const text = (prompt.value || "").trim();
    if (!text) return;
    prompt.value = "";
    autoResizeTextarea(prompt);
    updateSendEnabled();
    await sendUserMessage(text);
    prompt.focus();
  });

  prompt.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    $("#sendBtn").click();
  });

  $("#newChatBtn").addEventListener("click", newChat);
  $("#sidebarToggle").addEventListener("click", () => {
    const isMobile = window.matchMedia("(max-width: 980px)").matches;
    if (isMobile) {
      setSidebarOpen(!state.sidebarOpen);
      return;
    }
    setSidebarCollapsed(!state.sidebarCollapsed);
  });

  $("#openSettingsBtn").addEventListener("click", () => {
    populateSettingsForm();
    openModal();
  });
  $("#openSettingsLink").addEventListener("click", (e) => {
    e.preventDefault();
    populateSettingsForm();
    openModal();
    closeSidebarIfMobile();
  });

  $("#closeSettingsBtn").addEventListener("click", closeModal);
  $("#cancelSettingsBtn").addEventListener("click", closeModal);

  $("#backdrop").addEventListener("click", () => {
    if (!$("#settingsModal").hidden) closeModal();
    if (state.sidebarOpen) setSidebarOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#settingsModal").hidden) closeModal();
      if (state.sidebarOpen) setSidebarOpen(false);
    }
    if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
      if (isModalOpen()) return;
      e.preventDefault();
      newChat();
    }
  });

  $("#saveSettingsBtn").addEventListener("click", () => {
    readSettingsForm();
    persistSettings();
    setModelLabels(state.settings.model);
    closeModal();
    if (!state.storageOk) {
      setStatus("Settings updated, but browser storage is blocked so they may not persist.");
    } else {
      setStatus("Saved settings.");
      setTimeout(() => setStatus(""), 1200);
    }
  });

  $("#refreshModelsBtn").addEventListener("click", async () => {
    $("#refreshModelsBtn").disabled = true;
    $("#refreshModelsBtn").textContent = "Loading...";
    try {
      readSettingsForm();
      const ids = await fetchModels();
      const merged = Array.from(new Set(["default", "fast", "pro", ...ids]));
      state.modelOptions = merged;
      populateSettingsForm();
      setStatus(`Loaded ${ids.length} model(s).`);
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Model refresh failed: ${msg}`);
    } finally {
      $("#refreshModelsBtn").disabled = false;
      $("#refreshModelsBtn").textContent = "Refresh";
    }
  });

  $("#clearAllBtn").addEventListener("click", () => {
    const ok = confirm("Clear all conversations and settings stored in this browser?");
    if (!ok) return;
    clearAllData();
    closeModal();
  });

  $("#exportBtn").addEventListener("click", () => exportActiveChat());

  $("#testProxyBtn").addEventListener("click", async () => {
    $("#testProxyBtn").disabled = true;
    const proxyStatus = $("#proxyStatus");
    if (proxyStatus) proxyStatus.textContent = "Testing...";
    try {
      readSettingsForm();
      await testProxy();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (proxyStatus) proxyStatus.textContent = `Failed: ${msg}`;
    } finally {
      $("#testProxyBtn").disabled = false;
    }
  });

  const historySearch = $("#historySearch");
  historySearch?.addEventListener("input", () => {
    state.historySearch = historySearch.value || "";
    renderSidebar();
  });
  $("#clearHistorySearchBtn")?.addEventListener("click", () => {
    state.historySearch = "";
    if (historySearch) historySearch.value = "";
    renderSidebar();
    historySearch?.focus?.();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      if (isModalOpen()) return;
      e.preventDefault();
      setSidebarOpen(true);
      historySearch?.focus?.();
    }
  });

  $("#toBottomBtn").addEventListener("click", () => {
    const chat = $("#chat");
    chat.scrollTop = chat.scrollHeight;
    updateToBottomBtn();
  });

  $("#chat").addEventListener("scroll", () => {
    updateToBottomBtn();
  });

  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 980px)").matches) {
      $("#sidebar").classList.remove("sidebar--open");
      state.sidebarOpen = false;
      $("#sidebarToggle")?.setAttribute?.("aria-expanded", "false");
    }
    syncBackdrop();
  });
}

function bootstrap() {
  loadState();
  setModelLabels(state.settings.model);
  wireEvents();
  renderAll({ forceScroll: true });
  autoResizeTextarea($("#prompt"));
  $("#sendBtn").disabled = true;
  $("#prompt").focus();

  // QA: detect when /api proxy isn't available (e.g., GitHub Pages or simple static servers).
  if (String(state.settings.baseUrl || "").startsWith("/api")) {
    fetchWithTimeout("/api/ping", { method: "GET", headers: { Accept: "application/json" } }, 6000)
      .then((resp) => {
        if (resp.ok) return;
        if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
          setStatus("API proxy not found on this host. Deploy to Vercel to enable /api.");
          return;
        }
      })
      .catch(() => {
        // Keep quiet: proxy may still work for chat even if /models fails.
      });
  }
}

bootstrap();
