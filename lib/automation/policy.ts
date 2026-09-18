import { createHash } from "node:crypto";
import type { AgentResult, CodingTask } from "../../types/automation";
export function taskId(messageId: string) { return createHash("sha256").update(messageId).digest("hex").slice(0, 16); }
export function parseCommand(text: string) {
  const command = /^(APPROVE|REJECT|STATUS)\s+([a-f0-9]{16})$/i.exec(text.trim());
  if (command) return { action: command[1].toUpperCase(), id: command[2].toLowerCase() };
  if (/^(APPROVE|REJECT|STATUS)\b/i.test(text.trim())) throw new Error("Use APPROVE, REJECT, or STATUS followed by the exact task ID.");
  return null;
}
export function canApprove(task: CodingTask, sender: string) {
  return task.sender === sender && task.status === "ready" && Boolean(task.head_sha && task.pr_number && task.preview_url);
}
export function validateEdits(value: unknown): AgentResult {
  if (!value || typeof value !== "object") throw new Error("Invalid agent output");
  const result = value as AgentResult;
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 2000 || !Array.isArray(result.files) || !result.files.length || result.files.length > 20) throw new Error("Invalid agent output");
  const seen = new Set<string>();
  let bytes = 0;
  for (const edit of result.files) {
    if (!edit || typeof edit.path !== "string" || typeof edit.content !== "string" || !/^(app|components|lib)\/[a-zA-Z0-9_./\[\]()-]+\.(js|jsx|ts|tsx|css|json)$/.test(edit.path) || edit.path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) || seen.has(edit.path)) throw new Error("Disallowed or duplicate edit path");
    seen.add(edit.path);
    bytes += Buffer.byteLength(edit.content);
  }
  if (bytes > 250000) throw new Error("Agent edits too large");
  return result;
}
export function assertReviewedHead(task: CodingTask, currentHead: string, currentBase: string) {
  if (task.status !== "approved" || !task.approved_sha || task.approved_sha !== task.head_sha || currentHead !== task.approved_sha || currentBase !== task.base_sha) throw new Error("Approval does not match the current PR head/base. Create a new task and review its preview.");
}
