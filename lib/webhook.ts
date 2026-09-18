import "server-only";
import { enabled } from "./automation/config";
import { acceptMessages } from "./automation/inbox";
import { dispatchWorker } from "./automation/github";
import { getAppSecret, getVerifyToken, getWhatsAppConfig } from "./config";
import { parseTextMessages, replyToTask, verifySignature } from "./whatsapp";

export function createWebhookHandlers(schedule: (work: () => Promise<void>) => void) {
  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    try {
      const token = getVerifyToken();
      if (params.get("hub.mode") !== "subscribe" || params.get("hub.verify_token") !== token || !params.get("hub.challenge")) {
        return Response.json({ error: "Verification failed" }, { status: 403 });
      }
      return new Response(params.get("hub.challenge"), { status: 200, headers: { "Content-Type": "text/plain" } });
    } catch {
      console.error("WhatsApp webhook verification configuration missing");
      return Response.json({ error: "Webhook configuration unavailable" }, { status: 503 });
    }
  }
  async function POST(request: Request): Promise<Response> {
    let secret: string;
    let phoneNumberId: string;
    try {
      secret = getAppSecret();
      phoneNumberId = getWhatsAppConfig().phoneNumberId;
    } catch {
      console.error("WhatsApp webhook configuration missing or invalid");
      return Response.json({ error: "Webhook configuration unavailable" }, { status: 503 });
    }
    let raw: string;
    try { raw = await request.text(); } catch {
      return Response.json({ error: "Unreadable request body" }, { status: 400 });
    }
    if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const messages = parseTextMessages(payload, phoneNumberId);
    if (enabled() && messages.length) {
      let accepted = false;
      try { accepted = await acceptMessages(messages); } catch {
        console.error("Automation inbox unavailable; inbound delivery not acknowledged");
        return Response.json({ error: "Task storage unavailable" }, { status: 503 });
      }
      if (accepted) schedule(async () => {
        try { await dispatchWorker(); } catch { console.error("Worker dispatch failed; scheduled worker will recover queued tasks"); }
      });
    } else if (messages.length) {
      // Vercel keeps this work alive after the webhook acknowledgement is returned.
      schedule(async () => {
        for (const message of messages) {
          console.info("WhatsApp incoming text", { sender: message.from, text: message.text });
          try { await replyToTask(message); } catch (error) {
            console.error("WhatsApp acknowledgement failed", { messageId: message.id, reason: error instanceof Error ? error.message : "Unknown send error" });
          }
        }
      });
    }
    return Response.json({ received: true }, { status: 200 });
  }

  return { GET, POST };
}
