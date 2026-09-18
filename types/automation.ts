export type TaskStatus = "queued" | "running" | "awaiting_preview" | "ready" | "approved" | "merged" | "rejected" | "failed";
export interface CodingTask {
  id: string; sender: string; instruction: string; status: TaskStatus;
  branch: string; base_branch: string | null; base_sha: string | null;
  head_sha: string | null; pr_number: number | null; pr_url: string | null;
  preview_url: string | null; summary: string | null; approved_sha: string | null;
}
export interface FileEdit { path: string; content: string }
export interface AgentResult { summary: string; files: FileEdit[] }
export interface CodingAgent {
  propose(instruction: string, files: Array<FileEdit>): Promise<AgentResult>;
}
