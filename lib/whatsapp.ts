import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getWhatsAppConfig } from "./config";
import type { IncomingTextMessage, WhatsAppTextRequest } from "../types/whatsapp";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function verifySignature(raw: string, signature: string | null, secret: string): boolean {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function parseTextMessages(payload: unknown, phoneNumberId: string): IncomingTextMessage[] {
  if (!record(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return [];
  const result: IncomingTextMessage[] = [];
  const seen = new Set<string>();
  for (const entry of payload.entry) {
    if (!record(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!record(change) || change.field !== "messages" || !record(change.value)) continue;
      const value = change.value;
      if (!record(value.metadata) || value.metadata.phone_number_id !== phoneNumberId || !Array.isArray(value.messages)) continue;
      for (const message of value.messages) {
        if (!record(message) || message.type !== "text" || !record(message.text)) continue;
        if (typeof message.id !== "string" || !message.id || seen.has(message.id) || typeof message.from !== "string" || !/^\d{5,20}$/.test(message.from) || typeof message.text.body !== "string" || !message.text.body.trim()) continue;
        seen.add(message.id);
        result.push({ id: message.id, from: message.from, text: message.text.body });
      }
    }
  }
  return result;
}
export async function sendTextMessage(to: string, body: string): Promise<void> {
  const { apiVersion, phoneNumberId, accessToken } = getWhatsAppConfig();
  const payload: WhatsAppTextRequest = { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } };
  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    // Do not log provider response bodies or request headers: they may contain sensitive data.
    throw new Error(`WhatsApp send failed (HTTP ${response.status})`);
  }
}
export async function replyToTask(message: IncomingTextMessage): Promise<void> {
  // WhatsApp text bodies are limited to 4096 characters. Split long acknowledgements.
  const characters = Array.from(`Received task: ${message.text}`);
  for (let offset = 0; offset < characters.length; offset += 4096) {
    await sendTextMessage(message.from, characters.slice(offset, offset + 4096).join(""));
  }
}
