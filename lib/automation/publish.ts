import "server-only";
import { github, targetPath } from "./github";
import { assertReviewedHead } from "./policy";
import type { CodingTask, AgentResult } from "../../types/automation";
export async function baseSnapshot() {
  const repo = await github<{ default_branch: string; private: boolean }>(targetPath);
  if (repo.private) throw new Error("This workspace adapter currently supports the public portfolio repository only");
  const commit = await github<{ sha: string; commit: { tree: { sha: string } } }>(`${targetPath}/commits/${encodeURIComponent(repo.default_branch)}`);
  return { branch: repo.default_branch, sha: commit.sha, tree: commit.commit.tree.sha };
}
export async function publish(task: CodingTask, base: Awaited<ReturnType<typeof baseSnapshot>>, result: AgentResult) {
  if (task.branch !== `whatsapp/task-${task.id}` || task.branch === base.branch || ["main", "master"].includes(task.branch)) throw new Error("Unsafe publication branch");
  const tree = await github<{ sha: string }>(`${targetPath}/git/trees`, "POST", { base_tree: base.tree, tree: result.files.map(file => ({ path: file.path, mode: "100644", type: "blob", content: file.content })) });
  if (tree.sha === base.tree) throw new Error("Agent proposed no effective changes");
  const commit = await github<{ sha: string }>(`${targetPath}/git/commits`, "POST", { message: `WhatsApp task ${task.id}: ${result.summary.slice(0, 100)}`, tree: tree.sha, parents: [base.sha] });
  // Only creates a new task ref. No operation updates main/master/default refs.
  await github(`${targetPath}/git/refs`, "POST", { ref: `refs/heads/${task.branch}`, sha: commit.sha });
  const pr = await github<{ number: number; html_url: string }>(`${targetPath}/pulls`, "POST", {
    title: `WhatsApp task ${task.id}: ${result.summary.slice(0, 100)}`, head: task.branch, base: base.branch,
    body: `${result.summary}\n\nValidation: isolated lint and Next.js production build passed.\n\nTask: ${task.id}. Merge only after explicit WhatsApp APPROVE ${task.id} for the reviewed head commit.`,
  });
  return { head: commit.sha, number: pr.number, url: pr.html_url };
}
export async function previewFor(sha: string) {
  const deployments = await github<Array<{ id: number; sha: string; environment: string; production_environment: boolean }>>(`${targetPath}/deployments?sha=${sha}&per_page=100`);
  for (const deployment of deployments) {
    if (deployment.sha !== sha || deployment.production_environment || !/preview/i.test(deployment.environment)) continue;
    const statuses = await github<Array<{ state: string; environment_url?: string; target_url?: string }>>(`${targetPath}/deployments/${deployment.id}/statuses?per_page=1`);
    const status = statuses[0];
    if (status?.state !== "success") continue;
    const value = status.environment_url || status.target_url;
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname.endsWith(".vercel.app")) return url.href;
  }
  return null;
}
export class PendingMergeError extends Error {}
export async function mergeApproved(task: CodingTask) {
  if (!task.pr_number || !task.head_sha || !task.base_branch) throw new Error("Missing PR metadata");
  const pr = await github<{ state: string; merged: boolean; head: { sha: string; ref: string }; base: { ref: string }; mergeable: boolean | null }>(`${targetPath}/pulls/${task.pr_number}`);
  // Recovery after GitHub accepted a merge but the database update failed.
  if (pr.merged && task.status === "approved" && task.approved_sha === task.head_sha && pr.head.sha === task.approved_sha && pr.head.ref === task.branch && pr.base.ref === task.base_branch) return;
  const currentBase = await github<{ sha: string }>(`${targetPath}/commits/${encodeURIComponent(task.base_branch)}`);
  assertReviewedHead(task, pr.head.sha, currentBase.sha);
  if (pr.state !== "open" || pr.head.ref !== task.branch || pr.base.ref !== task.base_branch || pr.mergeable === false) throw new Error("PR is not safely mergeable");
  if (pr.mergeable === null) throw new PendingMergeError("GitHub is still checking mergeability");
  const status = await github<{ state: string; total_count: number }>(`${targetPath}/commits/${task.head_sha}/status`);
  const checks = await github<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(`${targetPath}/commits/${task.head_sha}/check-runs?per_page=100`);
  if ((status.total_count > 0 && status.state === "pending") || checks.check_runs.some(check => check.status !== "completed")) throw new PendingMergeError("PR checks are still running");
  if ((status.total_count > 0 && status.state !== "success") || checks.total_count > 100 || checks.check_runs.some(check => !["success", "neutral", "skipped"].includes(check.conclusion ?? ""))) throw new Error("PR checks are not all successful");
  const result = await github<{ merged: boolean }>(`${targetPath}/pulls/${task.pr_number}/merge`, "PUT", { sha: task.approved_sha, merge_method: "squash" });
  if (!result.merged) throw new Error("GitHub did not merge the PR");
}
