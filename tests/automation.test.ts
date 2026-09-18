import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { taskId, parseCommand, validateEdits, canApprove, assertReviewedHead } from "../lib/automation/policy";
import { acceptMessages } from "../lib/automation/inbox";
import { applyEdits } from "../lib/automation/workspace";
import { mergeApproved, publish, previewFor } from "../lib/automation/publish";
import type { CodingTask } from "../types/automation";
import type { transaction } from "../lib/automation/store";
process.env.WHATSAPP_ALLOWED_SENDERS = "919876543210";
process.env.GITHUB_AUTOMATION_TOKEN = "test-only-token";
const sender = "919876543210";
function readyTask(): CodingTask {
  return { id: "0123456789abcdef", sender, instruction: "Fix hero", status: "ready", branch: "whatsapp/task-0123456789abcdef", base_branch: "master", base_sha: "a".repeat(40), head_sha: "b".repeat(40), pr_number: 1, pr_url: "https://github.com/example/pr/1", preview_url: "https://preview.vercel.app", summary: "Fixed hero", approved_sha: null };
}
test("commands require exact task IDs, and only ready tasks owned by sender can be approved", () => {
  assert.deepEqual(parseCommand(" APPROVE 0123456789ABCDEF "), { action: "APPROVE", id: "0123456789abcdef" });
  assert.throws(() => parseCommand("APPROVE"));
  assert.throws(() => parseCommand("APPROVE 0123456789abcdef please"));
  assert.equal(parseCommand("Fix hero"), null);
  assert.equal(canApprove(readyTask(), sender), true);
  assert.equal(canApprove(readyTask(), "other"), false);
  assert.equal(canApprove({ ...readyTask(), status: "queued" }, sender), false);
  assert.equal(taskId("message-a"), taskId("message-a"));
  assert.notEqual(taskId("message-a"), taskId("message-b"));
});
test("edit policy rejects traversal, secrets, workflows, package changes, and duplicates", () => {
  for (const path of ["../app/page.tsx", "app/../lib/file.ts", ".env.local", ".github/workflows/ci.yml", "package.json", "lib/.secret.json", "/app/page.tsx", "app//page.tsx"]) {
    assert.throws(() => validateEdits({ summary: "fix", files: [{ path, content: "bad" }] }), path);
  }
  assert.throws(() => validateEdits({ summary: "fix", files: [{ path: "app/page.tsx", content: "a" }, { path: "app/page.tsx", content: "b" }] }));
  assert.equal(validateEdits({ summary: "fix", files: [{ path: "components/Header.jsx", content: "updated" }] }).files.length, 1);
});
test("approval is invalid after either the reviewed head or base changes", () => {
  const task = { ...readyTask(), status: "approved" as const, approved_sha: "b".repeat(40) };
  assert.doesNotThrow(() => assertReviewedHead(task, task.head_sha!, task.base_sha!));
  assert.throws(() => assertReviewedHead(task, "c".repeat(40), task.base_sha!));
  assert.throws(() => assertReviewedHead(task, task.head_sha!, "c".repeat(40)));
  assert.throws(() => assertReviewedHead(readyTask(), task.head_sha!, task.base_sha!));
});
test("durable inbox deduplicates deliveries, blocks unknown senders, and records exact approved SHA", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL("../scripts/schema.sql", import.meta.url), "utf8"));
    const transact: typeof transaction = async run => db.transaction(async tx => {
      const client = { query: async (sql: string, params: unknown[]) => {
        const result = await tx.query(sql, params);
        return { rows: result.rows, rowCount: result.affectedRows };
      } } as unknown as PoolClient;
      return run(client);
    });
    const incoming = { id: "incoming-1", from: sender, text: "Fix hero" };
    assert.equal(await acceptMessages([incoming], transact), true);
    assert.equal(await acceptMessages([incoming], transact), false);
    await acceptMessages([{ ...incoming, id: "unauthorized", from: "919999999999" }], transact);
    const tasks = await db.query<CodingTask>("SELECT * FROM coding_tasks");
    assert.equal(tasks.rows.length, 1);
    assert.equal(tasks.rows[0].status, "queued");
    const id = tasks.rows[0].id;
    await acceptMessages([{ id: "too-early", from: sender, text: `APPROVE ${id}` }], transact);
    assert.equal((await db.query<CodingTask>("SELECT * FROM coding_tasks")).rows[0].status, "queued");
    await db.query("UPDATE coding_tasks SET status='ready',head_sha=$1,pr_number=1,preview_url='https://preview.vercel.app'", ["b".repeat(40)]);
    await acceptMessages([{ id: "approval", from: sender, text: `APPROVE ${id}` }], transact);
    const approved = (await db.query<CodingTask>("SELECT * FROM coding_tasks")).rows[0];
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_sha, "b".repeat(40));
    await acceptMessages([{ id: "reject-after-approval", from: sender, text: `REJECT ${id}` }], transact);
    assert.equal((await db.query<CodingTask>("SELECT * FROM coding_tasks")).rows[0].status, "approved");
    assert.ok((await db.query("SELECT * FROM whatsapp_outbox")).rows.length >= 3);
  } finally { await db.close(); }
});
test("candidate writing rejects symlink parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-test-"));
  try {
    await mkdir(join(root, "app"));
    await symlink(tmpdir(), join(root, "app", "linked"));
    await assert.rejects(applyEdits(root, [{ path: "app/linked/agent-file.ts", content: "bad" }]), /Symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("publication refuses the default branch and merging refuses stale approvals", async () => {
  await assert.rejects(publish({ ...readyTask(), branch: "master" }, { branch: "master", sha: "a".repeat(40), tree: "d".repeat(40) }, { summary: "fix", files: [{ path: "app/page.tsx", content: "test" }] }), /Unsafe/);
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method !== "GET") writes++;
    if (String(url).includes("/pulls/")) return Response.json({ state: "open", merged: false, mergeable: true, head: { sha: "c".repeat(40), ref: readyTask().branch }, base: { ref: "master" } });
    return Response.json({ sha: "a".repeat(40) });
  };
  try {
    await assert.rejects(mergeApproved({ ...readyTask(), status: "approved", approved_sha: "b".repeat(40) }), /Approval/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = original; }
});
test("preview lookup ignores production deployments and deployments for another SHA", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (!String(url).includes("/statuses")) return Response.json([
      { id: 1, sha: "b".repeat(40), environment: "Production", production_environment: true },
      { id: 2, sha: "c".repeat(40), environment: "Preview", production_environment: false },
      { id: 3, sha: "b".repeat(40), environment: "Preview", production_environment: false },
    ]);
    assert.ok(String(url).includes("/3/statuses"));
    return Response.json([{ state: "success", environment_url: "https://review.vercel.app" }]);
  };
  try { assert.equal(await previewFor("b".repeat(40)), "https://review.vercel.app/"); }
  finally { globalThis.fetch = original; }
});
test("approved merge sends the exact reviewed SHA and supports check-run-only CI", async () => {
  const original = globalThis.fetch;
  const task = { ...readyTask(), status: "approved" as const, approved_sha: "b".repeat(40) };
  let merged = false;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/merge")) {
      assert.equal(init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), { sha: task.approved_sha, merge_method: "squash" });
      merged = true;
      return Response.json({ merged: true });
    }
    if (path.includes("/pulls/")) return Response.json({ state: "open", merged: false, mergeable: true, head: { sha: task.head_sha, ref: task.branch }, base: { ref: "master" } });
    if (path.endsWith("/status")) return Response.json({ state: "pending", total_count: 0 });
    if (path.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });
    return Response.json({ sha: task.base_sha });
  };
  try { await mergeApproved(task); assert.equal(merged, true); }
  finally { globalThis.fetch = original; }
});
