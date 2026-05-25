// Markdown rendering wrapper (marked + DOMPurify + relative-path rewrite).
// Used for: assistant text / conversation bubble body / status.md banner / inline .md rendering in the Files tab.
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false, pedantic: false });

// Force rel="noopener noreferrer" on target=_blank links to prevent reverse tabnabbing.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Render markdown → a safe HTML string sanitized by DOMPurify.
 * @param {string} text
 * @param {{taskId?: string, mdPath?: string}} [opts] When taskId+mdPath are provided, relative-path links/images are rewritten to the files API.
 */
export function renderMarkdown(text, { taskId = null, mdPath = null } = {}) {
  if (!text) return "";
  let md = text;
  if (taskId && mdPath) md = rewriteRelativePaths(md, taskId, mdPath);
  const raw = marked.parse(md);
  return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
}

function rewriteRelativePaths(md, taskId, mdPath) {
  const baseDir = mdPath.substring(0, mdPath.lastIndexOf("/") + 1);
  const filesUrl = (rel) =>
    `/api/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(baseDir + rel)}`;
  // Images ![alt](rel/path.png)
  md = md.replace(/!\[([^\]]*)\]\(((?!https?:|\/|data:)[^)]+)\)/g, (_m, alt, rel) => `![${alt}](${filesUrl(rel)})`);
  // Links [text](rel/path) (excluding images, absolute, anchors)
  md = md.replace(/(?<!!)\[([^\]]+)\]\(((?!https?:|\/|data:|#)[^)]+)\)/g, (_m, txt, rel) => `[${txt}](${filesUrl(rel)})`);
  return md;
}
