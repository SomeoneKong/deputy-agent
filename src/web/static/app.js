// SPA: native ES modules + fetch + EventSource, no build step.
// Data fetching / view switching / action panel / SSE assembly live here; per-row rendering is delegated to render.js.
import { $, el, renderStreamLine, renderSessionDivider, renderConvRow, renderEventCard } from "./render.js";
import { renderMarkdown } from "./md.js";
import { t, getLang, setLang, onLangChange, initI18n } from "./i18n.js";

const enc = encodeURIComponent;

let currentTaskId = null;
let currentTab = "conversation";
let detailEs = null;
let listEs = null;
let liveStreamTail = null; // lines container of the current stream tab's latest file, for SSE incremental append
// View epoch: incremented on each openTask / selectTab; async loaders compare after await and discard stale write-backs (guards against fast-switch races).
let viewEpoch = 0;
// Delete-in-flight flag: freeze view switching until the DELETE request returns, to avoid interleaving a reopened SSE with the delete command's lock probe.
let deleting = false;
let currentStage = null; // current task stage (for localizing the status-bar summary, consistent with the chip)
let currentStatusMd = ""; // most recent status.md content (the status bar re-renders from this on either stage / status_md event, guarding against ordering races)
let currentTitle = ""; // current task title (for inline rename display/editing)
let titleTaskId = null; // taskId the displayed title belongs to (prevents editing the wrong task during a task-switch hydration window)
const TITLE_MAX = 60;

// stage labels come from i18n (the enum key is unchanged); they update automatically on re-render when the language changes.
const STAGE_KEYS = [
  "submitted", "clarifying", "bootstrapping", "running", "awaiting_user",
  "paused", "done", "failed", "cancelled",
];
function stageLabel(stage) {
  return STAGE_KEYS.includes(stage) ? t("stage." + stage) : stage;
}
const STREAM_TABS = ["meta", "worker", "watcher", "reviewer"];
const TABS = ["conversation", "events", "meta", "worker", "watcher", "reviewer", "files", "hostlog"];
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/; // matches the backend TASK_ID_PATTERN; used to validate hash-route parsing
let hydratedTaskId = null; // taskId that has fully hydrated (header+action rendered); distinct from "currently opening"
const STREAM_TAIL = 1000;

function toast(msg, level = "info") {
  const node = el("div", "toast toast-" + level, msg);
  $("#toast").append(node);
  setTimeout(() => node.remove(), 3500);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body && body.message ? body.message : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function stageChip(stage) {
  return el("span", "stage-chip stage-" + stage, stageLabel(stage));
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// File preview classification: md → rendered; text (incl. jsonl) → raw <pre>; other → download only.
const MD_EXT = [".md", ".markdown"];
const TEXT_EXT = [
  ".txt", ".log", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".csv", ".tsv",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".vue", ".sh", ".bash", ".html", ".css", ".scss", ".less",
  ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".rst", ".tex", ".sql", ".diff", ".patch",
  ".java", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".c", ".cpp", ".h", ".hpp",
];
const TEXT_PREVIEW_MAX = 200_000; // max characters shown in text preview; beyond this it truncates and suggests download
function fileKind(name) {
  const lower = name.toLowerCase();
  if (MD_EXT.some((x) => lower.endsWith(x))) return "md";
  if (TEXT_EXT.some((x) => lower.endsWith(x))) return "text";
  return "binary";
}

// ---- Task list ----
async function loadList() {
  try {
    renderList((await api("/api/tasks")).tasks);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderList(tasks) {
  const ul = $("#task-list");
  ul.innerHTML = "";
  for (const task of tasks) {
    const li = el("li");
    if (task.taskId === currentTaskId) li.classList.add("active");
    li.append(el("span", "title", task.title || t("misc.untitled")));
    const meta = el("div", "meta");
    meta.append(stageChip(task.stage));
    meta.append(el("span", "mono", task.taskId));
    li.append(meta);
    li.onclick = () => goTask(task.taskId);
    ul.append(li);
  }
}

function startListStream() {
  if (listEs) listEs.close();
  listEs = new EventSource("/api/stream/tasks");
  listEs.addEventListener("task_list", (ev) => {
    try { renderList(JSON.parse(ev.data).tasks); } catch {}
  });
}

// ---- Task detail ----
async function openTask(taskId, tab) {
  const targetTab = TABS.includes(tab) ? tab : (currentTab || "conversation");
  currentTaskId = taskId;
  hydratedTaskId = null; // hydration started, not yet complete (applyRoute uses this to know the same task needs reopening rather than just a tab switch)
  const epoch = ++viewEpoch;
  $("#empty-view").hidden = true;
  $("#new-task-view").hidden = true;
  $("#detail-view").hidden = false;
  await loadList();
  try {
    const info = await api(`/api/tasks/${enc(taskId)}`);
    if (epoch !== viewEpoch) return; // already switched to another view
    renderHeader(info);
    renderActionPanel(info.manifest.stage);
  } catch (e) {
    if (epoch !== viewEpoch) return;
    if (e.status === 404) {
      // Deep link / back-forward to a deleted task → converge to the empty view and replaceState the bad hash (no back-trap)
      history.replaceState(null, "", "#/");
      showEmptyView();
    } else {
      // Non-404 transient error: currentTaskId already switched to the new task but header/action still reflect the old one →
      // clear the old task's residue to prevent a destructive misfire from the view (old) and currentTaskId (new) being inconsistent (e.g. cancel the wrong task); a refresh can retry.
      toast(e.message, "error");
      renderDetailError(taskId);
    }
    return;
  }
  if (epoch !== viewEpoch) return;
  hydratedTaskId = taskId; // hydration complete
  selectTab(targetTab);
}

function renderHeader(info) {
  setTitleDisplay((info.manifest.title || "").trim());
  $("#detail-taskid").textContent = info.manifest.taskId;
  currentStage = info.manifest.stage;
  currentStatusMd = info.statusMd || "";
  const chipHost = $("#stage-chip");
  chipHost.className = "stage-chip stage-" + info.manifest.stage;
  chipHost.textContent = stageLabel(info.manifest.stage);
  const host = $("#host-status");
  host.textContent = info.hostOnline ? t("status.host_online") : t("status.host_offline");
  host.className = "badge " + (info.hostOnline ? "online" : "offline");
  setStatusBanner();
}

// The top "current status" only shows the stage enum description: full Meta messages (questions / reports) are read
// in the Conversation tab, not stacked again in the status area. The summary prefers currentStage localized via
// stageLabel() (consistent with the chip, switches with UI language); the English `**Status**: xxx` line in
// status.md is only a fallback source when currentStage is absent.
function extractStatusSummary(md) {
  if (!md) return "";
  const m = md.match(/\*\*Status\*\*\s*[：:]\s*(.+)/);
  if (m) return m[1].trim();
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("---")) continue;
    return line.replace(/^\*\*|\*\*$/g, "");
  }
  return "";
}
function extractStatusReason(md) {
  const m = (md || "").match(/\*\*(?:Cancellation reason|Reason)\*\*\s*[：:]\s*(.+)/);
  return m ? m[1].trim() : "";
}
function setStatusBanner() {
  const banner = $("#status-banner");
  banner.innerHTML = "";
  const summary = currentStage ? stageLabel(currentStage) : extractStatusSummary(currentStatusMd);
  if (!summary) return;
  const line = el("div", "status-line");
  const text = el("span", "status-text", summary);
  text.title = summary;
  line.append(el("span", "status-label", t("status.current_label")), text);
  banner.append(line);
  const reason = extractStatusReason(currentStatusMd); // failure / cancellation reason: key info, not redundant
  if (reason) {
    const err = el("div", "status-error");
    err.append(el("span", "status-label", t("status.reason_label")), el("span", null, reason));
    banner.append(err);
  }
}

// Detail hydrate failure (non-404 transient error): clear the old task's residual header chip / action panel / tab to avoid inconsistency with the already-switched currentTaskId.
function renderDetailError(taskId) {
  // Close the old detail stream: on a same-task re-hydrate failure the old SSE's live() would still be true, otherwise
  // later stage / status_md events would re-render the action panel / status bar, turning the "load failed" error view
  // half-operable. A refresh / re-navigation reopens it via startDetailStream.
  if (detailEs) { detailEs.close(); detailEs = null; }
  setTitleDisplay("");
  $("#detail-taskid").textContent = taskId;
  currentStage = null;
  currentStatusMd = "";
  const chip = $("#stage-chip"); chip.className = "stage-chip"; chip.textContent = "";
  const host = $("#host-status"); host.className = "badge"; host.textContent = "—";
  $("#status-banner").innerHTML = "";
  $("#action-panel").innerHTML = "";
  const body = $("#tab-body");
  body.innerHTML = "";
  body.append(el("div", "empty-hint", t("misc.task_load_failed")));
}

// ---- Inline rename (click the title to edit) ----
function setTitleDisplay(title) {
  currentTitle = title;
  titleTaskId = currentTaskId;
  const host = $("#detail-title");
  const staleInput = host.querySelector(".title-input");
  if (staleInput) staleInput.onblur = null; // clear onblur when removing a focused input, to prevent a synchronous blur re-entrant write-back
  host.innerHTML = "";
  const isEmpty = !title;
  const span = el("span", "title-text" + (isEmpty ? " title-empty" : ""), isEmpty ? t("misc.title_click_to_name") : title);
  span.title = isEmpty ? t("misc.title_name_hint") : title + t("misc.title_rename_hint");
  const pencil = el("span", "title-pencil", "✎");
  span.onclick = startEditTitle;
  pencil.onclick = startEditTitle;
  host.append(span, pencil);
}

function startEditTitle() {
  if (titleTaskId !== currentTaskId) return; // displayed title belongs to the old task (task-switch hydration window) → do not enter edit
  const taskId = currentTaskId;
  const host = $("#detail-title");
  host.innerHTML = "";
  const input = el("input", "title-input");
  input.type = "text";
  input.value = currentTitle;
  input.maxLength = TITLE_MAX;
  input.placeholder = t("misc.title_placeholder");
  let settled = false;
  const finish = (title) => { if (settled) return; settled = true; setTitleDisplay(title); };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (settled) return; // save in flight (already settled) → ignore repeated Enter
      void saveTitle(input, taskId, () => { settled = true; });
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(currentTitle);
    }
  };
  input.onblur = () => finish(currentTitle); // blur cancels (only Enter saves)
  host.append(input);
  input.focus();
  input.select();
}

async function saveTitle(input, taskId, markSettled) {
  const next = input.value.trim();
  if (!next) { toast(t("toast.title_empty"), "warning"); input.focus(); return; } // validation failed → stay in edit mode (not settled)
  if (next === currentTitle) { input.onblur = null; markSettled(); setTitleDisplay(currentTitle); return; }
  // Entering submit: settle + disable editing, to avoid a re-render blur write-back / repeated Enter on slow networks submitting multiple times (>60 is bounded by input.maxLength + backend)
  input.onblur = null;
  input.disabled = true;
  markSettled();
  try {
    await api(`/api/tasks/${enc(taskId)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    toast(t("toast.title_updated"));
    if (taskId === currentTaskId) { setTitleDisplay(next); loadList(); } // optimistic update + refresh sidebar
  } catch (e) {
    toast(e.message, "error");
    if (taskId === currentTaskId) setTitleDisplay(currentTitle); // revert on failure
  }
}

function selectTab(tab) {
  if (deleting) return; // delete in flight freezes view switching to avoid reopening this task's SSE
  currentTab = tab;
  liveStreamTail = null;
  const epoch = ++viewEpoch;
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  const body = $("#tab-body");
  body.innerHTML = "";
  body.append(el("div", "empty-hint", t("misc.loading")));
  if (tab === "conversation") loadConversation(body, epoch);
  else if (tab === "events") loadEvents(body, epoch);
  else if (tab === "files") loadFiles(body, epoch);
  else if (tab === "hostlog") loadHostLog(body, epoch);
  else loadStream(body, tab, epoch);
  startDetailStream();
}

/** Used by loaders after an await to decide whether this result still belongs to the current view (stale → discard, do not write DOM). */
function stale(epoch) {
  return epoch !== viewEpoch;
}

async function loadConversation(body, epoch) {
  try {
    const { rows } = await api(`/api/tasks/${enc(currentTaskId)}/conversation`);
    if (stale(epoch)) return;
    body.innerHTML = "";
    if (!rows.length) { body.append(el("div", "empty-hint", t("misc.empty_conversation"))); return; }
    for (const r of rows) renderConvRow(body, r, currentTaskId);
  } catch (e) { if (!stale(epoch)) { body.innerHTML = ""; body.append(el("div", "empty-hint", e.message)); } }
}

async function loadEvents(body, epoch) {
  try {
    const { events } = await api(`/api/tasks/${enc(currentTaskId)}/events`);
    if (stale(epoch)) return;
    body.innerHTML = "";
    if (!events.length) { body.append(el("div", "empty-hint", t("misc.empty_events"))); return; }
    for (const e of events) renderEventCard(body, e);
  } catch (e) { if (!stale(epoch)) { body.innerHTML = ""; body.append(el("div", "empty-hint", e.message)); } }
}

async function loadStream(body, agent, epoch) {
  try {
    const { files } = await api(`/api/tasks/${enc(currentTaskId)}/streams/${agent}`);
    if (stale(epoch)) return;
    body.innerHTML = "";
    if (!files.length) { body.append(el("div", "empty-hint", t("misc.empty_stream"))); return; }
    const ctx = { taskId: currentTaskId, container: body };
    let idx = 0;
    let lastLinesBox = null;
    for (const f of files) {
      idx += 1;
      const box = await renderStreamFile(body, agent, f.file, idx, ctx, epoch);
      if (stale(epoch)) return;
      if (box) lastLinesBox = box;
    }
    // Only the last session file container is the SSE live-append target: avoids increments landing in an earlier session container during the initial multi-file load (misplacement).
    liveStreamTail = lastLinesBox;
  } catch (e) { if (!stale(epoch)) { body.innerHTML = ""; body.append(el("div", "empty-hint", e.message)); } }
}

async function renderStreamFile(body, agent, file, idx, ctx, epoch) {
  const res = await api(`/api/tasks/${enc(currentTaskId)}/streams/${agent}/${enc(file)}?tail=${STREAM_TAIL}`);
  if (stale(epoch)) return;
  const lines = res.lines || [];
  const first = lines[0];
  renderSessionDivider(body, {
    index: idx,
    sessionId: first?.sessionId,
    firstReceivedAt: first?.receivedAt,
    taskId: currentTaskId,
  });

  // Load earlier content: when headOffset > 0, can keep tailing further back.
  let headOffset = res.headOffset;
  const linesBox = el("div", "stream-lines");
  if (headOffset > 0) {
    const earlier = el("button", "load-earlier", t("action.load_earlier"));
    earlier.onclick = async () => {
      const taskId = currentTaskId;
      earlier.disabled = true;
      try {
        const more = await api(`/api/tasks/${enc(taskId)}/streams/${agent}/${enc(file)}?tail=${STREAM_TAIL}&beforeOffset=${headOffset}`);
        if (stale(epoch) || taskId !== currentTaskId || !linesBox.isConnected) return; // view switched, discard
        headOffset = more.headOffset;
        const frag = document.createDocumentFragment();
        for (const l of more.lines || []) renderStreamLine(frag, l, ctx);
        linesBox.insertBefore(frag, linesBox.firstChild);
        if (headOffset <= 0) earlier.remove();
        else earlier.disabled = false;
      } catch (e) {
        if (!stale(epoch) && taskId === currentTaskId && linesBox.isConnected) { toast(e.message, "error"); earlier.disabled = false; }
      }
    };
    body.append(earlier);
  }
  body.append(linesBox);
  for (const l of lines) renderStreamLine(linesBox, l, ctx);
  return linesBox; // loadStream sets only the last file container as the live-append target after the loop
}

async function loadFiles(body, epoch) {
  const taskId = currentTaskId; // task this tree belongs to (passed to previewFile / fileLink, prevents an old-tree click requesting the wrong task during a switch window)
  try {
    const { tree } = await api(`/api/tasks/${enc(taskId)}/files`);
    if (stale(epoch)) return;
    body.innerHTML = "";
    if (!tree.length) { body.append(el("div", "empty-hint", t("misc.empty_files"))); return; }
    // Two columns (master-detail): tree on the left, preview on the right. The preview column is sticky so it stays in
    // the viewport even when the tree scrolls, avoiding a single-column layout where clicking a file near the bottom
    // renders the preview above the list and off-screen → seems "unresponsive".
    const pane = el("div", "files-pane");
    const treeCol = el("div", "file-tree-col");
    const preview = el("div", "file-preview");
    preview.append(el("div", "empty-hint", t("misc.preview_placeholder"))); // initial placeholder (previewFile clears and rebuilds)
    const ul = el("ul", "file-tree");
    // The backend listWorkspaceTree returns a flat DFS pre-order list (parent dirs before children); reconstruct the tree shape by indenting per relPath depth; show leaf names.
    for (const e of tree) {
      const depth = e.relPath.split("/").length - 1;
      const li = el("li");
      li.style.paddingLeft = `${depth * 16}px`;
      if (e.type === "dir") {
        li.append(el("span", "tree-dir", "📁 " + e.name));
      } else {
        const kind = fileKind(e.name);
        if (kind === "binary") {
          li.append(fileLink(taskId, e.relPath, "📄 " + e.name), el("span", "tree-size", fmtSize(e.sizeBytes)));
        } else {
          // md / text (incl. jsonl): click the filename for inline preview; with a download link alongside.
          const a = el("a", "tree-file", "📄 " + e.name);
          a.href = "#";
          a.onclick = (ev) => { ev.preventDefault(); previewFile(preview, taskId, e.relPath, kind); };
          li.append(a, el("span", "tree-size", fmtSize(e.sizeBytes)), document.createTextNode(" "), fileLink(taskId, e.relPath, t("action.download")));
        }
      }
      ul.append(li);
    }
    treeCol.append(ul);
    pane.append(treeCol, preview);
    body.append(pane);
  } catch (e) { if (!stale(epoch)) { body.innerHTML = ""; body.append(el("div", "empty-hint", e.message)); } }
}

function fileLink(taskId, relPath, label) {
  const a = el("a", null, label);
  a.href = `/api/tasks/${enc(taskId)}/files?path=${enc(relPath)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** Read only the text prefix (about maxChars characters) then cancel the download, avoiding pulling a huge jsonl/log fully into browser memory. */
async function fetchTextHead(url, maxChars) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body || typeof res.body.getReader !== "function") {
    const full = await res.text(); // fallback: no streaming body → read whole + truncate
    return full.length > maxChars ? { text: full.slice(0, maxChars), truncated: true } : { text: full, truncated: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) { truncated = true; break; } // stop once the prefix is enough; cancel aborts the remaining download
    }
    text += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, truncated };
}

let previewSeq = 0;
async function previewFile(preview, taskId, relPath, kind) {
  if (taskId !== currentTaskId) return; // clicked an old-tree row during a task-switch window → discard (do not request the wrong task / do not write the old preview)
  const seq = ++previewSeq; // guard against rapid clicks: a late response for an old file must not overwrite a newer preview
  const fresh = () => seq === previewSeq && taskId === currentTaskId && preview.isConnected;
  preview.innerHTML = "";
  const head = el("div", "preview-head");
  head.append(el("span", null, "📄 " + relPath));
  head.append(fileLink(taskId, relPath, t("action.download")));
  preview.append(head);
  try {
    if (kind === "md") {
      const text = await api(`/api/tasks/${enc(taskId)}/files?path=${enc(relPath)}&render=markdown`);
      if (!fresh()) return;
      const d = el("div", "md-render");
      d.innerHTML = renderMarkdown(text, { taskId, mdPath: relPath });
      preview.append(d);
    } else {
      // text / jsonl: stream the prefix (bypasses api()'s json parsing; takes ~TEXT_PREVIEW_MAX without downloading the whole file).
      const { text, truncated } = await fetchTextHead(`/api/tasks/${enc(taskId)}/files?path=${enc(relPath)}`, TEXT_PREVIEW_MAX);
      if (!fresh()) return;
      const shown = truncated ? text + "\n" + t("misc.preview_truncated") : text;
      preview.append(el("pre", "text-preview", shown));
    }
  } catch (e) {
    if (fresh()) preview.append(el("div", "empty-hint", e.message || t("misc.preview_failed")));
  }
}

async function loadHostLog(body, epoch) {
  try {
    const text = await api(`/api/tasks/${enc(currentTaskId)}/host-log?tail=500`);
    if (stale(epoch)) return;
    body.innerHTML = "";
    body.append(el("pre", "hostlog", text || t("misc.empty_hostlog")));
  } catch (e) { if (!stale(epoch)) { body.innerHTML = ""; body.append(el("div", "empty-hint", e.message)); } }
}

// ---- Action panel (switches by stage) ----
function renderActionPanel(stage) {
  const p = $("#action-panel");
  p.innerHTML = "";
  const terminal = ["done", "failed", "cancelled"].includes(stage);

  if (stage === "paused") {
    const row = el("div", "action-row");
    row.append(actionBtn("resume", t("action.resume"), "btn-primary"), actionBtn("cancel", t("action.cancel"), "btn-danger"));
    p.append(row);
    return;
  }
  if (terminal || stage === "submitted") {
    p.append(el("div", "empty-hint", terminal ? t("misc.task_ended") : t("misc.task_creating")));
    return;
  }
  const ta = el("textarea");
  ta.rows = 3;
  ta.placeholder = stage === "clarifying" ? t("action.answer_placeholder") : t("action.feedback_placeholder");
  p.append(ta);

  const row = el("div", "action-row");
  const mainAction = stage === "clarifying" ? "answer" : "feedback";
  const send = el("button", "btn btn-primary", stage === "clarifying" ? t("action.answer") : t("action.feedback"));
  send.onclick = () => doWrite(mainAction, { text: ta.value });
  row.append(send);

  const fileInput = el("input");
  fileInput.type = "file";
  const up = el("button", "btn", t("action.upload"));
  up.onclick = () => doUpload(fileInput.files[0]);
  row.append(fileInput, up);

  if (stage === "awaiting_user") row.append(actionBtn("done", t("action.accept_delivery"), "btn-primary"));
  row.append(actionBtn("pause", t("action.pause"), "btn"), actionBtn("cancel", t("action.cancel"), "btn-danger"));
  p.append(row);
}

function actionBtn(action, label, cls) {
  const b = el("button", "btn " + (cls || ""), label);
  b.onclick = () => doWrite(action, {});
  return b;
}

async function doWrite(action, payload) {
  const taskId = currentTaskId;
  try {
    const r = await api(`/api/tasks/${enc(taskId)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast(r.message || t("toast.submitted"));
    if (r.warning) toast(r.warning, "warning");
    if (taskId === currentTaskId) openTask(taskId);
  } catch (e) { toast(e.message, "error"); }
}

async function doDelete() {
  const taskId = currentTaskId;
  if (!taskId || deleting) return;
  const name = currentTitle || taskId; // use the title as the source of truth, avoid reading #detail-title.textContent which mixes in the ✎ child node text
  if (!window.confirm(t("confirm.delete_task", { name }))) return;
  // Close the detail stream first: stop this task's host probing and file watching to release Windows file handles so the recursive delete is clean;
  // the deleting flag + disabled button freeze view switching to avoid interleaving a reopened SSE with the delete command's lock probe while DELETE is in flight.
  deleting = true;
  $("#delete-btn").disabled = true;
  if (detailEs) { detailEs.close(); detailEs = null; }
  ++viewEpoch; // invalidate in-flight detail-view loaders
  try {
    const r = await api(`/api/tasks/${enc(taskId)}`, { method: "DELETE" });
    toast(r.message || t("toast.deleted"));
    if (taskId === currentTaskId) goEmpty(); // navigate to the empty view after deletion (hash → applyRoute → showEmptyView)
    await loadList();
  } catch (e) {
    if (e.status === 404) {
      // Already deleted (e.g. by another tab) → converge to the empty view, do not restore detail
      toast(e.message || t("toast.task_gone"));
      if (taskId === currentTaskId) goEmpty();
      await loadList();
    } else {
      toast(e.message, "error"); // e.g. 409 if the host is running
      if (taskId === currentTaskId) { deleting = false; openTask(taskId); } // restore the live view
    }
  } finally {
    deleting = false;
    $("#delete-btn").disabled = false;
  }
}

async function doUpload(file) {
  if (!file) { toast(t("toast.select_file"), "warning"); return; }
  const taskId = currentTaskId;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await api(`/api/tasks/${enc(taskId)}/uploads`, { method: "POST", body: fd });
    toast(r.message || t("toast.uploaded"));
    if (taskId === currentTaskId) openTask(taskId);
  } catch (e) { toast(e.message, "error"); }
}

// ---- Detail SSE ----
function startDetailStream() {
  if (detailEs) { detailEs.close(); detailEs = null; }
  if (!currentTaskId) return;
  const esTaskId = currentTaskId; // capture the task this connection belongs to; event callbacks use it to block cross-task bleed-in
  const agent = STREAM_TABS.includes(currentTab) ? currentTab : "meta";
  const es = new EventSource(`/api/stream/tasks/${enc(esTaskId)}?agent=${agent}`);
  detailEs = es;
  const live = () => es === detailEs && esTaskId === currentTaskId; // still the current connection + current task
  es.addEventListener("stage", (ev) => {
    if (!live()) return;
    try {
      const { stage } = JSON.parse(ev.data);
      currentStage = stage;
      const chip = $("#stage-chip");
      chip.className = "stage-chip stage-" + stage;
      chip.textContent = stageLabel(stage);
      renderActionPanel(stage);
      setStatusBanner(); // re-render the status bar on stage change too, in case status_md arrived first and the summary disagrees with the chip
    } catch {}
  });
  es.addEventListener("host_status", (ev) => {
    if (!live()) return;
    try {
      const { online } = JSON.parse(ev.data);
      const h = $("#host-status");
      h.textContent = online ? t("status.host_online") : t("status.host_offline");
      h.className = "badge " + (online ? "online" : "offline");
    } catch {}
  });
  es.addEventListener("conversation_append", () => {
    if (live() && currentTab === "conversation") loadConversation($("#tab-body"), viewEpoch);
  });
  es.addEventListener("event_append", () => {
    if (live() && currentTab === "events") loadEvents($("#tab-body"), viewEpoch);
  });
  es.addEventListener("stream_append", (ev) => {
    if (!live()) return;
    try {
      const data = JSON.parse(ev.data);
      // Check payload.tab === currentTab: on fast tab switches, queued events from the old connection may arrive late; avoid old-agent rows bleeding into the new tab.
      if (data.tab !== currentTab || !liveStreamTail) return;
      const ctx = { taskId: currentTaskId, container: $("#tab-body") };
      for (const l of data.lines) renderStreamLine(liveStreamTail, l, ctx);
    } catch {}
  });
  es.addEventListener("status_md", (ev) => {
    if (!live()) return;
    try { currentStatusMd = JSON.parse(ev.data).content || ""; setStatusBanner(); } catch {}
  });
  // A new session stream file appeared → if viewing the corresponding stream tab, reselect to switch to the latest source.
  es.addEventListener("new_stream_file", () => {
    if (live() && STREAM_TABS.includes(currentTab)) selectTab(currentTab);
  });
  // Backend detection may miss a push → re-hydrate the current tab.
  es.addEventListener("lag", () => { if (live()) selectTab(currentTab); });
}

// ---- View rendering (called by applyRoute) ----
function showNewTaskView() {
  if (detailEs) { detailEs.close(); detailEs = null; }
  ++viewEpoch; // invalidate in-flight detail-view loaders
  currentTaskId = null;
  hydratedTaskId = null;
  $("#empty-view").hidden = true;
  $("#detail-view").hidden = true;
  $("#new-task-view").hidden = false;
  resetNewTaskForm();
}

function showEmptyView() {
  if (detailEs) { detailEs.close(); detailEs = null; }
  ++viewEpoch;
  currentTaskId = null;
  hydratedTaskId = null;
  $("#detail-view").hidden = true;
  $("#new-task-view").hidden = true;
  $("#empty-view").hidden = false;
}

// ---- Client-side hash routing (no server-side routing): #/task/<id>/<tab> | #/new | #/ ----
function parseHash() {
  let parts;
  try {
    // Do not filter empty segments (keep positional semantics: #/task//x does not collapse to task x); decodeURIComponent throws on bad percent escapes → fall back to empty.
    parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    return { view: "empty" };
  }
  if (parts[0] === "task") {
    const taskId = parts[1] || "";
    if (!TASK_ID_RE.test(taskId)) return { view: "empty" }; // empty / invalid id → do not open
    return { view: "task", taskId, tab: TABS.includes(parts[2]) ? parts[2] : "conversation" };
  }
  if (parts[0] === "new") return { view: "new" };
  return { view: "empty" };
}

async function applyRoute() {
  const r = parseHash();
  if (r.view === "new") return showNewTaskView();
  if (r.view === "empty") return showEmptyView();
  // If the target task has not finished hydrating (hydratedTaskId !== r.taskId), reopen even for the same id to avoid half-rendering (a tab-only switch would cancel the unfinished header/action render).
  if (r.taskId !== currentTaskId || hydratedTaskId !== r.taskId) await openTask(r.taskId, r.tab);
  else if (r.tab !== currentTab) selectTab(r.tab);
}

// UI actions only change the hash → hashchange → applyRoute renders (setting the same value does not fire hashchange, naturally guarding against re-entry).
function goTask(taskId, tab) { location.hash = `#/task/${encodeURIComponent(taskId)}/${tab || currentTab || "conversation"}`; }
function goNew() { location.hash = "#/new"; }
function goEmpty() { location.hash = "#/"; }

// ---- New-task form state and interactions ----
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // matches the backend UPLOAD_MAX_BYTES (frontend pre-check, backend enforces)
let ntFiles = [];        // selected attachments File[]
let ntSubmitting = false;

/** Reset all form state when entering the new-task view (textarea / attachments / advanced options / progress / role providers). */
function resetNewTaskForm() {
  ntSubmitting = false;
  ntFiles = [];
  ntRoleSel = {};
  $("#raw-task").value = "";
  $("#new-task-id").value = "";
  $("#new-files").value = "";
  $("#nt-adv").hidden = true;
  $("#nt-adv-toggle").textContent = t("nt.adv_show");
  $("#nt-progress").hidden = true;
  renderNtFiles();
  updateNtCharCount();
  syncNtDisabled();
  void renderNtRoles();
}

function updateNtCharCount() {
  $("#nt-charcount").textContent = t("nt.charcount", { n: $("#raw-task").value.length });
}

/** Sync submit-button availability + disabled state while submitting. */
function syncNtDisabled() {
  const canSubmit = !ntSubmitting && $("#raw-task").value.trim().length > 0;
  $("#submit-btn").disabled = !canSubmit;
  $("#submit-btn").textContent = ntSubmitting ? t("nt.submitting") : t("nt.submit");
  for (const id of ["#raw-task", "#new-task-id", "#nt-cancel", "#nt-back", "#nt-adv-toggle"]) {
    $(id).disabled = ntSubmitting;
  }
  for (const s of document.querySelectorAll(".nt-role-select")) s.disabled = ntSubmitting;
  $("#nt-dropzone").classList.toggle("nt-disabled", ntSubmitting);
}

// ---- per-role provider selection ----
// Agent names (Meta/Worker/Watcher/Reviewer) are not translated; only the role description before the parenthesis is localized.
function ntRoleLabel(role) {
  const NAMES = { meta: "Meta", worker: "Worker", watcher: "Watcher", reviewer: "Reviewer" };
  return NAMES[role] ? `${t("misc.role_" + role)} (${NAMES[role]})` : role;
}
let ntProviders = null; // GET /api/providers cache (static within the process, loaded once)
let ntRoleSel = {};     // role -> provider (only explicit user changes count; unset = inherit project config, defaulting to Claude if unconfigured)

async function ensureProvidersLoaded() {
  if (ntProviders) return ntProviders;
  try {
    ntProviders = await api("/api/providers");
  } catch {
    ntProviders = null;
  }
  return ntProviders;
}

function ntSupportBadge(support) {
  if (support === "ok") return el("span", "nt-badge nt-badge-ok", t("nt.support_ok"));
  if (support === "limited") return el("span", "nt-badge nt-badge-limited", t("nt.support_limited"));
  return el("span", "nt-badge nt-badge-unsupported", t("nt.support_unsupported"));
}

/** Render the per-role provider selection rows (select + capability badge/note). The capability matrix comes from /api/providers. */
async function renderNtRoles() {
  const grid = $("#nt-roles-grid");
  if (!grid) return;
  const p = await ensureProvidersLoaded();
  grid.innerHTML = "";
  if (!p) { grid.textContent = t("nt.roles_load_failed"); return; }
  for (const role of p.roles) {
    const row = el("div", "nt-role-row");
    row.append(el("span", "nt-role-name", ntRoleLabel(role)));

    const sel = document.createElement("select");
    sel.className = "nt-role-select";
    sel.disabled = ntSubmitting;
    const defOpt = document.createElement("option");
    defOpt.value = "";
    // Unset = follow the priority chain (project config > default Claude); do not hardcode a provider name to avoid misleading when project config overrides.
    defOpt.textContent = t("nt.provider_default");
    sel.append(defOpt);
    for (const prov of p.providers) {
      const opt = document.createElement("option");
      opt.value = prov.provider;
      const sup = p.capabilityMatrix[role] && p.capabilityMatrix[role][prov.provider];
      const fixedModel = (prov.models[0] && prov.models[0].modelId) || "";
      opt.textContent = `${prov.label}${fixedModel ? ` (${fixedModel})` : ""}`;
      if (sup && sup.support === "unsupported") { opt.disabled = true; opt.textContent += t("nt.provider_unsupported_suffix"); }
      sel.append(opt);
    }
    sel.value = ntRoleSel[role] || "";

    const hint = el("div", "nt-role-hint");
    const updateHint = () => {
      hint.innerHTML = "";
      const prov = sel.value;
      if (!prov) return;
      const sup = p.capabilityMatrix[role] && p.capabilityMatrix[role][prov];
      if (!sup) return;
      hint.append(ntSupportBadge(sup.support));
      if (sup.note) hint.append(el("span", "nt-role-note", sup.note));
    };
    sel.onchange = () => {
      if (sel.value) ntRoleSel[role] = sel.value; else delete ntRoleSel[role];
      updateHint();
    };
    updateHint();
    row.append(sel, hint);
    grid.append(row);
  }
}

/** Add files (dedupe + skip over-size). */
function addNtFiles(fileList) {
  if (!fileList) return;
  for (const f of Array.from(fileList)) {
    if (f.size > MAX_UPLOAD_BYTES) { toast(t("toast.file_too_large", { name: f.name }), "warning"); continue; }
    if (ntFiles.some((x) => x.name === f.name && x.size === f.size)) continue; // same name + size treated as duplicate
    ntFiles.push(f);
  }
  renderNtFiles();
}

function removeNtFile(idx) {
  ntFiles.splice(idx, 1);
  renderNtFiles();
}

/** Render the selected attachment list (filename / size / remove + total). */
function renderNtFiles() {
  const box = $("#nt-filelist");
  box.innerHTML = "";
  if (!ntFiles.length) return;
  ntFiles.forEach((f, i) => {
    const row = el("div", "nt-file-row");
    const left = el("div", "nt-file-meta");
    left.append(el("span", null, "📄"), el("span", "nt-file-name", f.name), el("span", "nt-file-size", fmtSize(f.size)));
    const rm = el("button", "nt-file-remove", "×");
    rm.title = t("action.remove");
    rm.disabled = ntSubmitting;
    rm.onclick = (ev) => { ev.stopPropagation(); if (!ntSubmitting) removeNtFile(i); };
    row.append(left, rm);
    box.append(row);
  });
  const total = ntFiles.reduce((acc, f) => acc + f.size, 0);
  box.append(el("div", "nt-file-total", t("nt.file_total", { n: ntFiles.length, size: fmtSize(total) })));
}

/** Submit: XHR upload (with progress); on success, navigate to the task detail. */
function submitTask() {
  if (ntSubmitting) return;
  const raw = $("#raw-task").value.trim();
  if (!raw) { toast(t("toast.need_task_desc"), "warning"); return; }

  const fd = new FormData();
  fd.append("rawTask", raw);
  const tid = $("#new-task-id").value.trim();
  if (tid) fd.append("taskId", tid);
  for (const f of ntFiles) fd.append("files", f);
  // per-role provider selection: only roles the user explicitly changed go into the payload; unset follows the fallback chain (project config / default Claude).
  if (Object.keys(ntRoleSel).length) {
    const roleBindings = {};
    for (const [role, provider] of Object.entries(ntRoleSel)) roleBindings[role] = { provider };
    fd.append("roleBindings", JSON.stringify(roleBindings));
  }

  ntSubmitting = true;
  syncNtDisabled();
  const hasFiles = ntFiles.length > 0;
  $("#nt-progress").hidden = !hasFiles;
  if (hasFiles) setNtProgress(0, 1);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/tasks");
  xhr.responseType = "json";
  if (hasFiles) {
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setNtProgress(e.loaded, e.total); };
  }
  xhr.onload = () => {
    ntSubmitting = false;
    $("#nt-progress").hidden = true;
    const r = xhr.response || {};
    if (xhr.status >= 200 && xhr.status < 300) {
      if (Array.isArray(r.failed) && r.failed.length) {
        for (const f of r.failed) toast(t("toast.file_upload_failed", { name: f.filename, message: f.message || "" }), "error");
      }
      if (Array.isArray(r.uploaded) && r.uploaded.length) toast(t("toast.files_uploaded", { n: r.uploaded.length }));
      if (r.warning) toast(r.warning, "warning");
      toast(r.message || t("toast.task_created", { taskId: r.taskId }));
      void loadList();
      goTask(r.taskId, "conversation");
    } else {
      syncNtDisabled();
      toast((r && r.message) || t("toast.submit_failed_http", { status: xhr.status }), "error");
    }
  };
  xhr.onerror = () => { ntSubmitting = false; $("#nt-progress").hidden = true; syncNtDisabled(); toast(t("toast.submit_failed_network"), "error"); };
  xhr.send(fd);
}

function setNtProgress(loaded, total) {
  const pct = total > 0 ? (loaded / total) * 100 : 0;
  $("#nt-progress-fill").style.width = `${pct.toFixed(1)}%`;
  $("#nt-progress-label").textContent = t("nt.uploading", { loaded: fmtSize(loaded), total: fmtSize(total) });
}

// ---- Language switching ----
// #lang-toggle shows the target language to switch to: shows Chinese when in en, shows EN when in zh.
function updateLangToggle() {
  $("#lang-toggle").textContent = getLang() === "en" ? t("lang.to_zh") : t("lang.to_en");
}

// After a language switch, re-render the JS-rendered parts (static [data-i18n] is already re-scanned by setLang).
// Reuse existing render functions and preserve view state: the detail view re-runs openTask (re-fetch info + re-render
// header/action/tab, keeping currentTaskId/tab); the list and lang-toggle refresh in any view; the new-task view
// re-renders dynamic labels (char count / submit button / advanced toggle / role rows).
onLangChange(() => {
  updateLangToggle();
  loadList();
  if (currentTaskId && !deleting && !$("#detail-view").hidden) {
    openTask(currentTaskId, currentTab);
  } else if (!$("#new-task-view").hidden) {
    updateNtCharCount();
    syncNtDisabled();
    $("#nt-adv-toggle").textContent = $("#nt-adv").hidden ? t("nt.adv_show") : t("nt.adv_hide");
    renderNtFiles();
    void renderNtRoles();
  }
});

// ---- Initialization ----
initI18n();          // apply persisted language + scan static [data-i18n] (must run before the first dynamic render)
updateLangToggle();
$("#lang-toggle").onclick = () => setLang(getLang() === "en" ? "zh" : "en");
$("#new-task-btn").onclick = goNew;
$("#submit-btn").onclick = submitTask;

// New-task form interactions
$("#nt-cancel").onclick = () => { if (!ntSubmitting) goEmpty(); };
$("#nt-back").onclick = () => { if (!ntSubmitting) goEmpty(); };
$("#raw-task").addEventListener("input", () => { updateNtCharCount(); syncNtDisabled(); });
$("#nt-adv-toggle").onclick = () => {
  if (ntSubmitting) return;
  const adv = $("#nt-adv");
  adv.hidden = !adv.hidden;
  $("#nt-adv-toggle").textContent = adv.hidden ? t("nt.adv_show") : t("nt.adv_hide");
};
const ntDrop = $("#nt-dropzone");
ntDrop.onclick = () => { if (!ntSubmitting) $("#new-files").click(); };
$("#new-files").addEventListener("change", (e) => { addNtFiles(e.target.files); e.target.value = ""; });
ntDrop.addEventListener("dragover", (e) => { if (ntSubmitting) return; e.preventDefault(); ntDrop.classList.add("nt-dragover"); });
ntDrop.addEventListener("dragleave", () => ntDrop.classList.remove("nt-dragover"));
ntDrop.addEventListener("drop", (e) => {
  if (ntSubmitting) return;
  e.preventDefault();
  ntDrop.classList.remove("nt-dragover");
  addNtFiles(e.dataTransfer?.files);
});
$("#delete-btn").onclick = doDelete;
$("#detail-taskid").onclick = () => {
  if (!currentTaskId || !navigator.clipboard) return;
  navigator.clipboard.writeText(currentTaskId).then(() => toast(t("toast.taskid_copied"))).catch(() => {});
};
for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => { if (currentTaskId) goTask(currentTaskId, b.dataset.tab); };
}
window.addEventListener("hashchange", () => { void applyRoute(); });
loadList();          // sidebar list (route-independent, always loaded)
startListStream();
void applyRoute();   // restore the view from the current URL hash (refresh / bookmark / deep link)
