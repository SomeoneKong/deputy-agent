/**
 * Renders the outcome summary inside the worker_session_end envelope body.md.
 *
 * Returns a markdown fragment (without the outer `## doneCriteria outcome: ...` heading, which the caller adds):
 * - overall=error -> only renders `- evaluator error: <reason>`, no check list
 * - all_pass -> head line `- N / N passed`
 * - some_fail -> head line + a `### failed / errored checks` list (two lines each: status + description)
 */
import type { CheckOutcome, DoneCriteriaOutcome } from "./types.js";

export function renderOutcomeSummary(outcome: DoneCriteriaOutcome): string {
  const { overall, summary } = outcome;
  if (overall === "error") {
    return `- evaluator error: ${summary.errorReason ?? "unknown_error"}\n`;
  }
  const { total, passed, failed, errored } = summary;
  let head = `- ${passed} / ${total} passed`;
  if (failed > 0) head += `, ${failed} fail`;
  if (errored > 0) head += `, ${errored} error`;
  head += "\n";
  if (overall === "all_pass") return head;

  const parts: string[] = [head, "\n### failed / errored checks\n"];
  for (const c of outcome.checks) {
    if (c.result === "pass") continue;
    parts.push(renderCheckLine(c));
  }
  return parts.join("");
}

function renderCheckLine(c: CheckOutcome): string {
  const head = renderHead(c.kind, c.detail);
  const suffix = renderSuffix(c.kind, c.detail, c.result);
  return `- [${c.checkId}] ${c.kind} ${head}: ${c.result}${suffix}\n  description: ${c.description}\n`;
}

function asStr(detail: Readonly<Record<string, unknown>>, key: string): string {
  const v = detail[key];
  return v === undefined || v === null ? "?" : String(v);
}

function renderHead(kind: string, detail: Readonly<Record<string, unknown>>): string {
  if (kind === "script") return `on ${asStr(detail, "scriptPath")}`;
  if (kind === "dir_min_files") return `on ${asStr(detail, "path")} (${asStr(detail, "pattern")})`;
  if (kind === "yaml_field_present") return `on ${asStr(detail, "path")} field=${asStr(detail, "field")}`;
  return `on ${asStr(detail, "path")}`;
}

function renderSuffix(kind: string, detail: Readonly<Record<string, unknown>>, result: string): string {
  const reason = detail["reason"];
  const reasonStr = typeof reason === "string" ? reason : undefined;
  if (result === "error") {
    if (kind === "script") {
      const rc = detail["returnCode"];
      if (rc !== undefined && rc !== null) {
        return reasonStr ? ` (returnCode=${String(rc)}, ${reasonStr})` : ` (returnCode=${String(rc)})`;
      }
    }
    return reasonStr ? ` (${reasonStr})` : "";
  }
  // fail: render the core metric per kind
  if (kind === "file_min_lines") return ` (${asStr(detail, "lines")} lines, min ${asStr(detail, "minLines")})`;
  if (kind === "file_min_bytes") return ` (${asStr(detail, "bytes")} bytes, min ${asStr(detail, "minBytes")})`;
  if (kind === "dir_min_files") return ` (${asStr(detail, "count")} matched, min ${asStr(detail, "minCount")})`;
  if (kind === "script") {
    const rc = detail["returnCode"];
    if (rc !== undefined && rc !== null) return ` (returnCode=${String(rc)})`;
  }
  return reasonStr ? ` (${reasonStr})` : "";
}
