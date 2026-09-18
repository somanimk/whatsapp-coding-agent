import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandlers } from "../lib/webhook";
const pending: Array<() => Promise<void>> = [];
const { GET, POST } = createWebhookHandlers(work => pending.push(work));
import { parseTextMessages, replyToTask, verifySignature } from "../lib/whatsapp";

Object.assign(process.env, {
  WHATSAPP_VERIFY_TOKEN: "test-verify", WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_ACCESS_TOKEN: "test-access", WHATSAPP_PHONE_NUMBER_ID: "123456",
  WHATSAPP_API_VERSION: "v25.0",
});
const message = { id: "wamid.test", from: "919876543210", type: "text", text: { body: "Fix the hero image" } };
function payload(messages: unknown[], phone = "123456") {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phone }, messages } }] }] };
}
function signedRequest(body: string) {
  return new Request("https://example.com/api/whatsapp/webhook", { method: "POST", body, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}` } });
}
test("verification returns exact challenge and rejects wrong tokens", async () => {
  const good = await GET(new Request("https://example.com?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345"));
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "12345");
  assert.equal((await GET(new Request("https://example.com?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123"))).status, 403);
  assert.equal((await GET(new Request("https://example.com?hub.mode=subscribe&hub.verify_token=test-verify"))).status, 403);
});
test("parser tolerates malformed structures, filters events, and deduplicates a batch", () => {
  for (const value of [null, [], 1, {}, { entry: [null] }]) assert.deepEqual(parseTextMessages(value, "123456"), []);
  assert.deepEqual(parseTextMessages(payload([message, null, { type: "image" }, message, { ...message, id: "bad", from: "not-a-phone" }]), "123456"), [{ id: message.id, from: message.from, text: message.text.body }]);
  assert.deepEqual(parseTextMessages(payload([message], "999999"), "123456"), []);
  assert.deepEqual(parseTextMessages({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ status: "delivered" }] } }] }] }, "123456"), []);
});
test("signature validation detects tampering and malformed signatures", () => {
  const body = JSON.stringify(payload([message]));
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  assert.equal(verifySignature(body, signature, "test-secret"), true);
  assert.equal(verifySignature(body + " ", signature, "test-secret"), false);
  assert.equal(verifySignature(body, "sha256=nope", "test-secret"), false);
  assert.equal(verifySignature(body, null, "test-secret"), false);
});
test("POST acknowledges unsupported signed events; rejects invalid signatures and JSON", async () => {
  const body = JSON.stringify(payload([]));
  assert.equal((await POST(signedRequest(body))).status, 200);
  assert.equal((await POST(signedRequest("{"))).status, 400);
  assert.equal((await POST(new Request("https://example.com", { method: "POST", body }))).status, 401);
});
test("reply sends correct authorization and payload; handles API rejection and long text", async () => {
  const original = globalThis.fetch;
  const bodies: Array<{ text: { body: string }; to: string }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://graph.facebook.com/v25.0/123456/messages");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-access");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.type, "text");
    bodies.push(body);
    return Response.json({ messages: [{ id: "sent" }] });
  };
  try {
    await replyToTask({ id: message.id, from: message.from, text: message.text.body });
    assert.equal(bodies[0].text.body, "Received task: Fix the hero image");
    assert.equal(bodies[0].to, message.from);
    bodies.length = 0;
    const text = "x".repeat(4096);
    await replyToTask({ id: "long", from: message.from, text });
    assert.equal(bodies.length, 2);
    assert.equal(bodies.map(body => body.text.body).join(""), `Received task: ${text}`);
    globalThis.fetch = async () => new Response("private provider body", { status: 401 });
    await assert.rejects(replyToTask({ id: "bad", from: message.from, text: "test" }), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});

test("valid text is acknowledged before the scheduled WhatsApp reply runs", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)).text.body);
    return Response.json({ messages: [{ id: "sent" }] });
  };
  try {
    pending.length = 0;
    const response = await POST(signedRequest(JSON.stringify(payload([message]))));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    assert.equal(calls.length, 0);
    assert.equal(pending.length, 1);
    await pending.shift()!();
    assert.deepEqual(calls, ["Received task: Fix the hero image"]);
    globalThis.fetch = async () => new Response("private error", { status: 500 });
    assert.equal((await POST(signedRequest(JSON.stringify(payload([message]))))).status, 200);
    await pending.shift()!(); // Failure is contained; valid inbound event remains acknowledged.
  } finally { globalThis.fetch = original; }
});
