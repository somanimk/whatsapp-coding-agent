import "server-only";
import { env, targetRepository, workerRepo } from "./config";
export async function github<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${env("GH_AUTOMATION_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status})`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
export const targetPath = `/repos/${targetRepository}`;
export async function dispatchWorker() {
  await github(`/repos/${workerRepo()}/actions/workflows/coding-worker.yml/dispatches`, "POST", { ref: env("GITHUB_WORKER_REF") });
}
