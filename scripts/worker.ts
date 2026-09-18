import { rm } from "node:fs/promises";
import { database, notify } from "../lib/automation/store";
import { OpenAIFileAgent } from "../lib/automation/agent";
import { createWorkspace, sourceFiles, applyEdits, validateWorkspace } from "../lib/automation/workspace";
import { baseSnapshot, publish, previewFor, mergeApproved, PendingMergeError } from "../lib/automation/publish";
import { replyToTask, sendTextMessage } from "../lib/whatsapp";
import type { CodingTask } from "../types/automation";

async function processTask(task: CodingTask) {
  const client = await database().connect();
  const lockKey = `task:${task.id}`;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [lockKey]);
    if (!lock.rows[0].acquired) return;
    const fresh = await client.query<CodingTask>("SELECT * FROM coding_tasks WHERE id=$1", [task.id]);
    task = fresh.rows[0];
    if (!["queued", "awaiting_preview", "approved"].includes(task.status)) return;
    if (task.status === "queued") {
      await client.query("UPDATE coding_tasks SET status='running',updated_at=now() WHERE id=$1", [task.id]);
      const base = await baseSnapshot();
      const root = await createWorkspace(base.sha);
      try {
        const result = await new OpenAIFileAgent().propose(task.instruction, await sourceFiles(root));
        await applyEdits(root, result.files);
        await validateWorkspace(root);
        const pr = await publish(task, base, result);
        await client.query("BEGIN");
        await client.query("UPDATE coding_tasks SET status='awaiting_preview',base_branch=$2,base_sha=$3,head_sha=$4,pr_number=$5,pr_url=$6,summary=$7,updated_at=now() WHERE id=$1", [task.id, base.branch, base.sha, pr.head, pr.number, pr.url, result.summary]);
        await notify(client, `pr:${task.id}`, task.sender, `Task ${task.id}: PR created.\n${result.summary}\n${pr.url}\nLint/build passed. Waiting for the Vercel preview; approval is not enabled yet.`);
        await client.query("COMMIT");
      } finally { await rm(root, { recursive: true, force: true }); }
    } else if (task.status === "awaiting_preview") {
      if (!task.head_sha) throw new Error("Missing task commit");
      const preview = await previewFor(task.head_sha);
      if (preview) {
        await client.query("BEGIN");
        const updated = await client.query("UPDATE coding_tasks SET status='ready',preview_url=$2,updated_at=now() WHERE id=$1 AND status='awaiting_preview' RETURNING id", [task.id, preview]);
        if (updated.rowCount) await notify(client, `ready:${task.id}`, task.sender, `Task ${task.id} ready for review.\n${task.summary}\nPR: ${task.pr_url}\nPreview: ${preview}\nReply APPROVE ${task.id} to merge, or REJECT ${task.id}.`);
        await client.query("COMMIT");
      } else {
        await client.query("UPDATE coding_tasks SET updated_at=now() WHERE id=$1 AND status='awaiting_preview'", [task.id]);
      }
    } else {
      await mergeApproved(task);
      await client.query("BEGIN");
      await client.query("UPDATE coding_tasks SET status='merged',updated_at=now() WHERE id=$1 AND status='approved'", [task.id]);
      await notify(client, `merged:${task.id}`, task.sender, `Task ${task.id} merged after your explicit approval.\n${task.pr_url}`);
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof PendingMergeError) return;
    console.error("Coding task failed", { taskId: task.id, reason: error instanceof Error ? error.message : "Unknown worker error" });
    await client.query("UPDATE coding_tasks SET status='failed',updated_at=now() WHERE id=$1 AND status IN ('running','approved')", [task.id]);
    await notify(client, `failed:${task.id}`, task.sender, `Task ${task.id} could not complete. No unapproved merge was performed. Check the worker logs; any created PR remains available for review.`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    client.release();
  }
}
async function flushReplies() {
  const client = await database().connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('whatsapp-outbox')) AS acquired");
    if (!lock.rows[0].acquired) return;
    const rows = await client.query("SELECT * FROM whatsapp_outbox WHERE delivered_at IS NULL AND next_attempt_at <= now() AND attempts < 5 ORDER BY id LIMIT 20");
    for (const row of rows.rows) {
      try {
        if (Array.from(row.body).length > 4096) await replyToTask({ id: String(row.id), from: row.sender, text: row.body.replace(/^Received task: /, "") });
        else await sendTextMessage(row.sender, row.body);
        await client.query("UPDATE whatsapp_outbox SET delivered_at=now(),attempts=attempts+1 WHERE id=$1", [row.id]);
      } catch {
        await client.query("UPDATE whatsapp_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '5 minutes' WHERE id=$1", [row.id]);
        console.error("WhatsApp outbox delivery failed", { outboxId: row.id });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('whatsapp-outbox'))"); client.release();
  }
}
if (process.env.AUTOMATION_ENABLED !== "true") {
  console.log("Automation worker paused; set its AUTOMATION_ENABLED variable to true after setup.");
} else {
try {
  await flushReplies();
  // Crashed runs are never resumed by silently regenerating or merging another commit.
  const stale = await database().query<CodingTask>("UPDATE coding_tasks SET status='failed',updated_at=now() WHERE status='running' AND updated_at < now()-interval '30 minutes' RETURNING *");
  const client = await database().connect();
  try { for (const task of stale.rows) await notify(client, `failed:${task.id}`, task.sender, `Task ${task.id}: worker interrupted. Please send a new task; nothing was auto-merged.`); } finally { client.release(); }
  const reviewTasks = await database().query<CodingTask>("SELECT * FROM coding_tasks WHERE status IN ('awaiting_preview','approved') ORDER BY CASE WHEN status='approved' THEN 0 ELSE 1 END,updated_at LIMIT 10");
  for (const task of reviewTasks.rows) await processTask(task);
  const queued = await database().query<CodingTask>("SELECT * FROM coding_tasks WHERE status='queued' ORDER BY created_at LIMIT 1");
  for (const task of queued.rows) await processTask(task);
  await flushReplies();
} finally { await database().end(); }

}
