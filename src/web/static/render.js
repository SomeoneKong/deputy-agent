// stream / conversation rendering layer. Branches on the kind of the wrapper's normalized SessionEvent (persisted in camelCase).
// app.js handles data fetching / views / SSE; this module only renders a single row into DOM.
import { renderMarkdown } from "./md.js";
import { t } from "./i18n.js";

// ---- Generic DOM helpers ----
export const $ = (sel) => document.querySelector(sel);
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function mdDiv(text, taskId) {
  const d = el("div", "md-render");
  d.innerHTML = renderMarkdown(text || "", taskId ? { taskId } : {});
  return d;
}

function shortId(id) {
  if (!id) return "";
  return id.length > 8 ? id.slice(-8) : id;
}
export function fmtTs(v) {
  if (v == null || v === "") return "";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}
function prettyJSON(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function modelStr(m) {
  if (m == null) return "";
  if (typeof m === "string") return m;
  return m.model || m.id || m.kind || prettyJSON(m);
}

/** Collapsible control: returns a toggle button that shows/hides contentEl. */
function collapsible(labelOpen, labelClosed, contentEl, defaultOpen = false) {
  const btn = el("button", "collapse-btn");
  let open = defaultOpen;
  const sync = () => {
    contentEl.style.display = open ? "" : "none";
    btn.textContent = open ? labelOpen : labelClosed;
  };
  sync();
  btn.onclick = () => {
    open = !open;
    sync();
  };
  return btn;
}

// host tool prefix → icon
const HOST_TOOL_ICON = [
  ["sh_msg__", "✉️"],
  ["sh_reviewer__", "🔎"],
  ["sh_inbox__", "📥"],
  ["sh_agent__", "🤖"],
  ["sh_stage__", "🚦"],
  ["sh_harness__", "🛠"],
];
function toolIcon(name, isHostTool) {
  if (isHostTool) {
    for (const [pfx, icon] of HOST_TOOL_ICON) if (name && name.startsWith(pfx)) return icon;
    return "🛠";
  }
  return "🔧";
}

// inject kind → i18n key (resolved live via t() at render time, supports language switching)
const INJECT_KIND_KEY = {
  first_message: "stream.inject.first_message",
  wake_inject: "stream.inject.wake_inject",
  compact_role_reinject: "stream.inject.compact_role_reinject",
  feedback_to_worker: "stream.inject.feedback_to_worker",
};

/** Build a stream card, returning {card, body}. The subagent chip is injected afterward by applySubagentChip. */
function streamCard({ cls, kindLabel, chip, ts }) {
  const card = el("div", "stream-msg " + cls);
  const head = el("div", "msg-head");
  head.append(el("span", "msg-kind", kindLabel));
  if (chip) head.append(el("span", "msg-chip", chip));
  if (ts != null) head.append(el("span", "msg-ts", fmtTs(ts)));
  card.append(head);
  const body = el("div", "msg-body");
  card.append(body);
  return { card, body };
}

/**
 * Subagent chip: any event carrying parentToolUseId (a subagent's internal assistant/tool + lifecycle events) gets a
 * `⤷ subagent <last8>` chip prepended to its header plus a card indent class. The chip id uses parentToolUseId
 * (= the Agent tool-call id that launched it), so all events of the same subagent share the same chip.
 */
function applySubagentChip(card, parentToolUseId) {
  if (!parentToolUseId || !card) return;
  card.classList.add("subagent-msg");
  const head = card.querySelector(".msg-head");
  if (!head) return;
  const s = el("span", "subagent-chip", "⤷ subagent " + shortId(parentToolUseId));
  s.title = "parentToolUseId=" + parentToolUseId;
  head.insertBefore(s, head.firstChild);
}

function metricsRow(pairs) {
  const row = el("div", "msg-metrics");
  for (const [k, v] of pairs) {
    if (v == null || v === "") continue;
    row.append(el("span", k.mono ? "mono" : null, `${k.label}=${v}`));
  }
  return row.childElementCount ? row : null;
}

function jumpTo(container, attr, id) {
  if (!container || !id) return;
  const target = container.querySelector(`[${attr}="${CSS.escape(id)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("jump-flash");
  void target.offsetWidth; // restart the animation
  target.classList.add("jump-flash");
}

/**
 * Render a single stream row into container. Returns the created card element (returns null for non-rendered cases like tool_use block / delta).
 * ctx: { taskId, container } — container is used to locate tool↔result jump targets.
 */
export function renderStreamLine(container, line, ctx = {}) {
  const taskId = ctx.taskId;
  const ts = line.receivedAt;
  let node = null;

  switch (line.kind) {
    case "session_started": {
      const { card, body } = streamCard({ cls: "stream-msg-system", kindLabel: "⚙ " + t("stream.session_start"), chip: line.role, ts });
      body.append(el("div", null, `${line.role || ""} · ${modelStr(line.model)}`));
      const det = el("pre", "json-block");
      det.textContent = prettyJSON({ model: line.model, cwd: line.cwd, thinking: line.thinking, providerSessionId: line.providerSessionId });
      body.append(collapsible(t("stream.collapse"), t("stream.expand_init"), det, false), det);
      node = card;
      break;
    }
    case "session_resumed": {
      const { card, body } = streamCard({ cls: "stream-msg-system", kindLabel: "↻ " + t("stream.session_resume"), ts });
      body.append(el("div", "mono", `resume → ${prettyJSON(line.resumeTarget)}`));
      node = card;
      break;
    }
    case "session_ended": {
      const s = line.stats || {};
      const { card, body } = streamCard({ cls: "stream-msg-result", kindLabel: "■ " + t("stream.session_exit"), chip: line.reason, ts });
      const m = metricsRow([
        [{ label: "turns" }, s.turnCount],
        [{ label: "tools" }, s.toolCallCount],
        [{ label: "errors" }, s.errorCount],
        [{ label: "tokens" }, s.tokens?.total],
        [{ label: "subagent_tokens" }, s.subagentTokens],
        [{ label: "cost$" }, s.cost != null ? s.cost.toFixed(4) : null],
      ]);
      if (m) body.append(m);
      node = card;
      break;
    }
    case "turn_started": {
      const cause = line.cause?.kind || "unknown";
      const { card } = streamCard({ cls: "stream-msg-system", kindLabel: "▷ " + t("stream.turn_start"), chip: cause, ts });
      node = card;
      break;
    }
    case "turn_ended": {
      const { card, body } = streamCard({ cls: "stream-msg-result", kindLabel: "✓ " + t("stream.turn_end"), chip: `stop=${line.stopReason}`, ts });
      const m = metricsRow([
        [{ label: "tokens" }, line.usage?.tokens?.total],
        [{ label: "cost$" }, line.usage?.cost != null ? line.usage.cost.toFixed(4) : null],
      ]);
      if (m) body.append(m);
      node = card;
      break;
    }
    case "assistant_block": {
      const b = line.block || {};
      if (b.type === "text") {
        const { card, body } = streamCard({ cls: "stream-msg-assistant", kindLabel: "💬 assistant", ts });
        body.append(mdDiv(b.text, taskId));
        node = card;
      } else if (b.type === "thinking") {
        const { card, body } = streamCard({ cls: "stream-msg-thinking", kindLabel: "💭 thinking", ts });
        const tk = el("div", null, b.thinking);
        body.append(collapsible(t("stream.collapse"), t("stream.expand"), tk, false), tk);
        node = card;
      }
      // tool_use block: deduplicated against the tool_invoked with the same toolUseId; the card is carried by tool_invoked → not rendered separately.
      break;
    }
    case "tool_invoked": {
      const { card, body } = streamCard({
        cls: "stream-msg-tool-use",
        kindLabel: `${toolIcon(line.toolName, line.isHostTool)} ${line.toolName}`,
        chip: `id=${shortId(line.toolUseId)}`,
        ts,
      });
      card.setAttribute("data-tooluse-invoke", line.toolUseId);
      const inp = el("pre", "json-block");
      inp.textContent = prettyJSON(line.input);
      const ctrl = el("div", "action-row");
      ctrl.append(collapsible(t("stream.collapse_input"), t("stream.expand_input"), inp, false));
      const jr = el("button", "collapse-btn", "↓ " + t("stream.jump_to_result"));
      jr.onclick = () => jumpTo(ctx.container, "data-tooluse-result", line.toolUseId);
      ctrl.append(jr);
      body.append(ctrl, inp);
      node = card;
      break;
    }
    case "tool_result_recorded": {
      const isErr = line.result?.isError;
      const { card, body } = streamCard({
        cls: isErr ? "stream-msg-tool-result-error" : "stream-msg-tool-result-ok",
        kindLabel: `${isErr ? "❌" : "✓"} ${t("stream.tool_result_of", { tool: line.toolName })}`,
        chip: `id=${shortId(line.toolUseId)}`,
        ts,
      });
      card.setAttribute("data-tooluse-result", line.toolUseId);
      const content = el("pre", "json-block");
      content.textContent = renderToolResultContent(line.result?.content);
      const ctrl = el("div", "action-row");
      const ju = el("button", "collapse-btn", "↑ " + t("stream.jump_to_invoke"));
      ju.onclick = () => jumpTo(ctx.container, "data-tooluse-invoke", line.toolUseId);
      ctrl.append(ju, collapsible(t("stream.collapse_content"), t("stream.expand_content"), content, false));
      body.append(ctrl, content);
      node = card;
      break;
    }
    case "compact_started": {
      const { card } = streamCard({ cls: "stream-msg-compact", kindLabel: "▼ " + t("stream.compact_start"), chip: `reason=${line.reason}`, ts });
      node = card;
      break;
    }
    case "compact_ended": {
      const { card, body } = streamCard({ cls: "stream-msg-compact", kindLabel: `${t("stream.compact_end")} success=${line.success}`, ts });
      if (line.success && line.summary) {
        const sm = mdDiv(line.summary, taskId);
        body.append(collapsible(t("stream.collapse_summary"), t("stream.expand_summary"), sm, false), sm);
      } else if (!line.success && line.errorMessage) {
        body.append(el("div", null, line.errorMessage));
      }
      node = card;
      break;
    }
    case "host_inject_requested": {
      const { card, body } = streamCard({ cls: "stream-msg-inject", kindLabel: t("stream.host_inject"), chip: line.marker?.kind, ts });
      const injKey = INJECT_KIND_KEY[line.marker?.kind];
      const note = injKey ? t(injKey) : line.marker?.kind || "";
      body.append(el("div", "mono", note + (line.marker?.humanNote ? ` · ${line.marker.humanNote}` : "")));
      const ids = line.marker?.envelopeIds || [];
      if (ids.length) {
        const list = el("pre", "json-block");
        list.textContent = ids.join("\n");
        body.append(collapsible(t("stream.collapse"), t("stream.inject_envelope_count", { count: ids.length }), list, false), list);
      }
      node = card;
      break;
    }
    case "inject_accepted":
    case "inject_queued":
    case "inject_delivered":
    case "inject_rejected":
    case "inject_cancelled":
    case "inject_dropped": {
      const detail =
        line.acceptedAs || line.queueKind || line.deliveryPath || line.reason || "";
      const { card } = streamCard({
        cls: "stream-msg-inject",
        kindLabel: line.kind.replace("inject_", "inject · "),
        chip: `${detail}${line.injectRequestId ? ` · req=${shortId(line.injectRequestId)}` : ""}`,
        ts,
      });
      node = card;
      break;
    }
    case "retry_started": {
      const { card, body } = streamCard({ cls: "stream-msg-ratelimit", kindLabel: "⟳ " + t("stream.sdk_retry"), chip: `attempt ${line.attempt}/${line.maxAttempts}`, ts });
      if (line.upstreamErrorBrief) body.append(el("div", null, line.upstreamErrorBrief));
      node = card;
      break;
    }
    case "retry_ended": {
      const { card, body } = streamCard({ cls: "stream-msg-ratelimit", kindLabel: `${t("stream.retry_end")} success=${line.success}`, ts });
      if (line.finalErrorBrief) body.append(el("div", null, line.finalErrorBrief));
      node = card;
      break;
    }
    case "usage_snapshot": {
      const { card, body } = streamCard({ cls: "stream-msg-result", kindLabel: "📊 " + t("stream.usage_snapshot"), ts });
      const m = metricsRow([
        [{ label: "tokens" }, line.tokens?.total],
        [{ label: "ctx%" }, line.contextUsage?.percent],
      ]);
      if (m) body.append(m);
      node = card;
      break;
    }
    case "subagent_started": {
      const { card, body } = streamCard({
        cls: "stream-msg-task-progress",
        kindLabel: "🧵 " + t("stream.subagent_start"),
        chip: line.subagentType,
        ts,
      });
      if (line.agentId) body.append(el("div", "mono", "agentId=" + line.agentId));
      if (line.description) body.append(el("div", null, line.description));
      node = card;
      break;
    }
    case "subagent_progress": {
      const { card, body } = streamCard({
        cls: "stream-msg-task-progress",
        kindLabel: "🧵 " + t("stream.subagent_progress"),
        ts,
      });
      const m = metricsRow([
        [{ label: "tool", mono: true }, line.lastToolName],
        [{ label: "tokens" }, line.usage?.totalTokens],
        [{ label: "tool_uses" }, line.usage?.toolUses],
        [{ label: "ms" }, line.usage?.durationMs],
      ]);
      if (m) body.append(m);
      node = card;
      break;
    }
    case "subagent_stopped": {
      const { card, body } = streamCard({
        cls: "stream-msg-task-progress",
        kindLabel: "🧵 " + t("stream.subagent_end"),
        chip: line.status,
        ts,
      });
      if (line.agentId) body.append(el("div", "mono", "agentId=" + line.agentId));
      if (line.summary) body.append(el("div", null, line.summary));
      const m = metricsRow([
        [{ label: "tokens" }, line.usage?.totalTokens],
        [{ label: "tool_uses" }, line.usage?.toolUses],
      ]);
      if (m) body.append(m);
      node = card;
      break;
    }
    case "runtime_error": {
      const { card, body } = streamCard({
        cls: line.recoverable ? "stream-msg-ratelimit" : "stream-msg-error",
        kindLabel: "⚠ runtime error",
        chip: line.error?.kind,
        ts,
      });
      body.append(el("div", "mono", `${line.error?.subKind || ""} ${line.error?.message || ""}`.trim()));
      node = card;
      break;
    }
    case "assistant_delta":
      return null; // streaming partial, hidden by default
    case "provider_raw": {
      // Noise reduction: system:status is a pure SDK request heartbeat (no observational value); rate_limit is meaningless when allowed, so render only when not allowed (near/at rate limit).
      if (line.providerEventType === "system:status") return null;
      if (line.providerEventType === "sdk:rate_limit_event" && line.raw?.rate_limit_info?.status === "allowed") return null;
      const { card, body } = streamCard({ cls: "stream-msg-unknown", kindLabel: "raw", chip: line.providerEventType, ts });
      const raw = el("pre", "json-block");
      raw.textContent = prettyJSON(line.raw);
      body.append(collapsible(t("stream.collapse"), t("stream.expand_raw"), raw, false), raw);
      node = card;
      break;
    }
    default: {
      const { card, body } = streamCard({ cls: "stream-msg-unknown", kindLabel: line.kind || "?", ts });
      const raw = el("pre", "json-block");
      raw.textContent = prettyJSON(line);
      body.append(collapsible(t("stream.collapse"), t("stream.expand"), raw, false), raw);
      node = card;
    }
  }

  // Inject the subagent chip: any event carrying parentToolUseId (internal assistant/tool + lifecycle) shares the same chip.
  if (node) applySubagentChip(node, line.parentToolUseId);
  if (node) container.append(node);
  return node;
}

function renderToolResultContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : prettyJSON(b)))
      .join("\n");
  }
  return prettyJSON(content);
}

// ---- session divider + lazy-loaded system prompt ----
const sysPromptCache = new Map();

export function renderSessionDivider(container, { index, sessionId, firstReceivedAt, taskId }) {
  const label = `Session #${index} · sid=${shortId(sessionId)} · ${fmtTs(firstReceivedAt)}`;
  container.append(el("div", "session-divider", label));
  if (!sessionId || !taskId) return;

  const row = el("div", "sysprompt-row");
  const bodyBox = el("div", "sysprompt-body");
  bodyBox.style.display = "none";
  let loaded = false;
  const btn = el("button", "collapse-btn", "📜 " + t("stream.system_prompt"));
  let open = false;
  btn.onclick = async () => {
    open = !open;
    bodyBox.style.display = open ? "" : "none";
    btn.textContent = open ? "📜 " + t("stream.system_prompt_collapse") : "📜 " + t("stream.system_prompt");
    if (open && !loaded) {
      loaded = true;
      try {
        let text = sysPromptCache.get(`${taskId}/${sessionId}`);
        if (text === undefined) {
          const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/agent_prompts/${encodeURIComponent(sessionId)}`);
          text = res.ok ? await res.text() : t("stream.system_prompt_none");
          sysPromptCache.set(`${taskId}/${sessionId}`, text);
        }
        bodyBox.append(mdDiv(text, taskId));
      } catch {
        bodyBox.append(el("div", "empty-hint", t("stream.system_prompt_load_failed")));
      }
    }
  };
  row.append(btn, bodyBox);
  container.append(row);
}

// ---- event cards (reuse the stream card visuals; extract key fields per type for direct display instead of showing raw JSON) ----
const EVENT_RESULT_RE = /(ended|failed|error|crash|timeout|exhausted|corrupt|degraded|killed|abort|reject)/i;

// Field-value helpers: array → "N items: a, b"; object → compact JSON; otherwise as-is.
function evtArr(x) {
  if (!Array.isArray(x) || x.length === 0) return null;
  return `${t("stream.evt.array_count", { count: x.length })}${x.map(String).join(", ")}`;
}
function evtObj(x) {
  if (x == null || typeof x !== "object" || Object.keys(x).length === 0) return null;
  return prettyJSON(x);
}
// Collect the names of boolean flags in details that are true (e.g. worker_stream_window's skipped/truncated).
function evtFlags(d, keys) {
  const on = keys.filter((k) => d[k] === true);
  return on.length ? on.join(", ") : null;
}

/**
 * Display spec per event type (schema-driven):
 * - icon/label: friendly title; chip: the most salient field (fn(details)).
 * - fields: [display name, value] (value is a details key or fn(details)); rows with null/empty values are skipped automatically.
 */
// Note: the events API's details fields are snake_case (matching the events.jsonl physical schema).
// label / field display names are i18n keys (resolved live via t(), supports language switching); icon / chip / values are not translated.
const EVENT_VIEW = {
  host_started:        { icon: "🟢", label: "stream.evt.host_started", chip: (d) => d.mode, fields: [["pid", "pid"]] },
  host_recovery:       { icon: "↻", label: "stream.evt.host_recovery", fields: [["stream.evt.f.summary", "summary"], ["stream.evt.f.quarantined", (d) => evtArr(d.quarantined)]] },
  host_recovery_failed:{ icon: "✗", label: "stream.evt.host_recovery_failed", chip: (d) => d.error_kind, fields: [["stream.evt.f.step", "step"], ["stream.evt.f.message", "message"]] },
  host_stopping:       { icon: "■", label: "stream.evt.host_stopping", chip: (d) => d.reason, fields: [["stream.evt.f.exit_code", "exit_code"]] },
  stage_transition:    { icon: "→", label: "stream.evt.stage_transition", chip: (d) => d.triggered_by, fields: [["stream.evt.f.transition", (d) => `${d.from_stage} → ${d.to_stage}`], ["stream.evt.f.reason", "reason"]] },
  agent_session_started:{ icon: "▶", label: "stream.evt.agent_session_started", chip: (d) => d.role, fields: [["session", (d) => shortId(d.session_id)], ["seq", "session_seq"], ["stream.evt.f.reason", "reason"]] },
  agent_session_ended: { icon: "⏹", label: "stream.evt.agent_session_ended", chip: (d) => d.role, fields: [["stream.evt.f.exit_reason", "exit_reason"], ["session", (d) => shortId(d.session_id)], ["seq", "session_seq"]] },
  watchdog_triggered:  { icon: "⏱", label: "stream.evt.watchdog_triggered", chip: (d) => d.watchdog_kind, fields: [["stream.evt.f.subject", "subject"], ["stream.evt.f.details", (d) => evtObj(d.details)]] },
  reviewer_triggered:  { icon: "🔍", label: "stream.evt.reviewer_triggered", chip: (d) => d.phase, fields: [["stream.evt.f.round", "round"], ["session", (d) => shortId(d.session_id)]] },
  worker_stream_window_dispatched: { icon: "📤", label: "stream.evt.worker_stream_window_dispatched", chip: (d) => `seq ${d.session_seq}`, fields: [["stream.evt.f.window", (d) => `${fmtTs(d.window_start)} ~ ${fmtTs(d.window_end)}`], ["envId", (d) => shortId(d.env_id)], ["stream.evt.f.flags", (d) => evtFlags(d, ["skipped", "enqueue_failed", "read_failed", "truncated"])]] },
  user_cli_action:     { icon: "👤", label: "stream.evt.user_cli_action", chip: (d) => d.action, fields: [["envId", (d) => shortId(d.env_id)], ["stream.evt.f.extra", (d) => evtObj(d.extra)]] },
  harness_changed:     { icon: "✎", label: "stream.evt.harness_changed", chip: (d) => d.harness_role, fields: [["stream.evt.f.path", "path"], ["stream.evt.f.bytes", "bytes_written"], ["session", (d) => shortId(d.by_session)], ["stream.evt.f.reason", "reason"]] },
  message_to_user:     { icon: "💬", label: "stream.evt.message_to_user", chip: (d) => d.intent, fields: [["stream.evt.f.bytes", "bytes"], ["session", (d) => shortId(d.by_session)]] },
  watcher_compact_triggered: { icon: "🗜", label: "stream.evt.watcher_compact_triggered", chip: (d) => `#${d.attempt}`, fields: [["tokens", (d) => `${d.total_tokens_before} / ${t("stream.evt.threshold")} ${d.threshold}`], ["session", (d) => shortId(d.session_id)]] },
  watcher_compact_role_reinjected: { icon: "↺", label: "stream.evt.watcher_compact_role_reinjected", chip: (d) => `#${d.attempt}`, fields: [["session", (d) => shortId(d.session_id)]] },
  watcher_compact_failed: { icon: "✗", label: "stream.evt.watcher_compact_failed", chip: (d) => d.error_kind, fields: [["stream.evt.f.failed_step", "failed_step"], ["session", (d) => shortId(d.session_id)]] },
  prompt_lang_fallback:{ icon: "🌐", label: "stream.evt.prompt_lang_fallback", chip: (d) => d.role, fields: [["stream.evt.f.lang", (d) => `${d.requested_lang} → ${d.used_lang}`], ["stream.evt.f.missing_assets", (d) => evtArr(d.missing_assets)]] },
};

// Field display names: i18n keys (stream.evt.f.* prefix) → translated via t(); the rest (technical terms like session/seq/tokens/pid/envId) shown as-is.
function evtFieldLabel(name) {
  return name.startsWith("stream.") ? t(name) : name;
}

function evtFieldValue(spec, d) {
  const v = typeof spec === "function" ? spec(d) : d[spec];
  return v == null || v === "" ? null : String(v);
}

export function renderEventCard(container, e) {
  const d = e.details && typeof e.details === "object" ? e.details : {};
  const view = EVENT_VIEW[e.type];
  const cls = EVENT_RESULT_RE.test(e.type || "") ? "stream-msg-result" : "stream-msg-system";

  const card = el("div", "stream-msg " + cls);
  const head = el("div", "msg-head");
  head.append(el("span", "msg-kind", view ? `${view.icon} ${t(view.label)}` : e.type));
  const chip = view && view.chip ? evtFieldValue(view.chip, d) : null;
  if (chip) head.append(el("span", "msg-chip", chip));
  if (e.stage) head.append(el("span", "msg-chip evt-stage", e.stage));
  head.append(el("span", "msg-ts", fmtTs(e.ts)));
  card.append(head);

  const body = el("div", "msg-body");
  if (view) {
    for (const [name, spec] of view.fields) {
      const val = evtFieldValue(spec, d);
      if (val === null) continue;
      const isMultiline = val.includes("\n");
      const row = el("div", "evt-field");
      row.append(el("span", "evt-field-k", evtFieldLabel(name)));
      row.append(el(isMultiline ? "pre" : "span", isMultiline ? "json-block" : "evt-field-v", val));
      body.append(row);
    }
  } else {
    // Unknown type (schema-drift fallback): generically render each scalar field as a row; nested objects/arrays shown compactly.
    for (const [k, raw] of Object.entries(d)) {
      const val = raw != null && typeof raw === "object" ? (Array.isArray(raw) ? evtArr(raw) : evtObj(raw)) : (raw == null ? null : String(raw));
      if (val == null || val === "") continue;
      const isMultiline = val.includes("\n");
      const row = el("div", "evt-field");
      row.append(el("span", "evt-field-k", k));
      row.append(el(isMultiline ? "pre" : "span", isMultiline ? "json-block" : "evt-field-v", val));
      body.append(row);
    }
  }
  card.append(body);
  container.append(card);
}

// ---- Conversation bubbles ----
// conv kind / intent → i18n key (resolved live via t(), supports language switching)
const CONV_KIND_KEY = {
  raw_task: "stream.conv.raw_task",
  user_clarify_answer: "stream.conv.user_clarify_answer",
  user_feedback: "stream.conv.user_feedback",
  user_upload: "stream.conv.user_upload",
  user_cancel: "stream.conv.user_cancel",
  user_done_confirmation: "stream.conv.user_done_confirmation",
  meta_message: "stream.conv.meta_message",
};
const CONV_INTENT_KEY = {
  question: "stream.conv.intent_question",
  delivery_report: "stream.conv.intent_delivery_report",
  notification: "stream.conv.intent_notification",
};

export function renderConvRow(container, row, taskId) {
  const isUser = row.direction === "user_to_meta";
  const rowDiv = el("div", "conv-row " + (isUser ? "conv-row-user" : "conv-row-meta"));
  const bubble = el("div", "conv-bubble " + (isUser ? "conv-bubble-user" : "conv-bubble-meta"));
  const head = el("div", "conv-head");
  const label = isUser
    ? (CONV_KIND_KEY[row.kind] ? t(CONV_KIND_KEY[row.kind]) : row.kind || "")
    : (CONV_INTENT_KEY[row.intent] ? t(CONV_INTENT_KEY[row.intent]) : row.intent || t("stream.conv.meta_message"));
  head.append(el("span", "label", label));
  head.append(el("span", null, fmtTs(row.ts)));
  const upId = row.extras?.uploadId;
  const fn = row.extras?.filename;
  if (row.kind === "user_upload" && upId && fn) {
    const a = el("a", null, t("stream.conv.download_copy"));
    a.href = `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(upId)}/${encodeURIComponent(fn)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    head.append(a);
  }
  bubble.append(head, mdDiv(row.body, taskId));
  rowDiv.append(bubble);
  container.append(rowDiv);
}
