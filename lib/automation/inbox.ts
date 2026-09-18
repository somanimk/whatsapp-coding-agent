import "server-only";
import type { IncomingTextMessage } from "../../types/whatsapp";
import type { CodingTask } from "../../types/automation";
import { allowedSenders } from "./config";
import { transaction, notify } from "./store";
import { taskId, parseCommand, canApprove } from "./policy";
export async function acceptMessages(messages: IncomingTextMessage[], transact: typeof transaction = transaction) {
  let accepted = false;
  const allowed = allowedSenders();
  for (const message of messages) {
    if (!allowed.includes(message.from)) continue;
    await transact(async client => {
      const inserted = await client.query("INSERT INTO whatsapp_events(message_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_id", [message.id]);
      if (!inserted.rowCount) return;
      accepted = true;
      let command;
      try { command = parseCommand(message.text); } catch {
        await notify(client, message.id, message.from, "Use APPROVE <task-id>, REJECT <task-id>, or STATUS <task-id> with the exact 16-character ID."); return;
      }
      if (command) {
        const row = await client.query<CodingTask>("SELECT * FROM coding_tasks WHERE id=$1 AND sender=$2 FOR UPDATE", [command.id, message.from]);
        const task = row.rows[0];
        if (!task) { await notify(client, message.id, message.from, "Task not found for your number."); return; }
        if (command.action === "APPROVE") {
          if (!canApprove(task, message.from)) { await notify(client, message.id, message.from, `Task ${task.id} is ${task.status}; approval requires a ready preview.`); return; }
          await client.query("UPDATE coding_tasks SET status='approved', approved_sha=head_sha, updated_at=now() WHERE id=$1", [task.id]);
          await notify(client, message.id, message.from, `Approval recorded for ${task.id}. The worker will verify the reviewed commit and checks before merging.`);
        } else if (command.action === "REJECT") {
          if (!["queued", "awaiting_preview", "ready"].includes(task.status)) { await notify(client, message.id, message.from, `Cannot reject task while ${task.status}.`); return; }
          await client.query("UPDATE coding_tasks SET status='rejected', updated_at=now() WHERE id=$1", [task.id]);
          await notify(client, message.id, message.from, `Task ${task.id} rejected; it will not merge.`);
        } else {
          await notify(client, message.id, message.from, `Task ${task.id}: ${task.status}\n${task.pr_url ?? ""}\n${task.preview_url ?? ""}`);
        }
        return;
      }
      if (message.text.length > 8000) { await notify(client, message.id, message.from, "Please keep coding instructions under 8000 characters."); return; }
      const id = taskId(message.id);
      await client.query("INSERT INTO coding_tasks(id,sender,instruction,status,branch) VALUES($1,$2,$3,'queued',$4)", [id, message.from, message.text, `whatsapp/task-${id}`]);
      await notify(client, `queued:${id}`, message.from, `Received task: ${message.text}\nTask ID: ${id}\nI will create a separate branch and PR. Nothing merges without APPROVE ${id}.`);
    });
  }
  return accepted;
}
