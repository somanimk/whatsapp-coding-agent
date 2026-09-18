import { after } from "next/server";
import { createWebhookHandlers } from "../../../../lib/webhook";
export const runtime = "nodejs";
export const maxDuration = 60;
export const { GET, POST } = createWebhookHandlers(work => after(work));
