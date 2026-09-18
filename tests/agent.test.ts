import test from "node:test";
import assert from "node:assert/strict";
import { createCodingAgent, GeminiFileAgent } from "../lib/automation/agent";

test("Gemini uses header authentication, validates output, and rejects incomplete responses", async () => {
  const originalFetch = globalThis.fetch;
  const previous = { provider: process.env.CODING_PROVIDER, key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.CODING_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-secret";
  process.env.GEMINI_MODEL = "test-model";
  try {
    assert.ok(createCodingAgent() instanceof GeminiFileAgent);
    globalThis.fetch = async (url, init) => {
      assert.ok(!String(url).includes("test-secret"));
      assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "test-secret");
      assert.equal(JSON.parse(String(init?.body)).generationConfig.responseMimeType, "application/json");
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ summary: "Fix spacing", files: [{ path: "components/Header.jsx", content: "export default function Header() { return null; }" }] }) }] } }] });
    };
    assert.equal((await createCodingAgent().propose("Fix spacing", [])).summary, "Fix spacing");
    globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }] });
    await assert.rejects(createCodingAgent().propose("Fix", []), /did not complete/);
    globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ summary: "Bad", files: [{ path: "../secret", content: "x" }] }) }] } }] });
    await assert.rejects(createCodingAgent().propose("Fix", []));
    globalThis.fetch = async () => new Response("private provider body", { status: 429 });
    await assert.rejects(createCodingAgent().propose("Fix", []), /HTTP 429/);
    process.env.CODING_PROVIDER = "unknown";
    assert.throws(createCodingAgent, /Unsupported/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["CODING_PROVIDER", previous.provider], ["GEMINI_API_KEY", previous.key], ["GEMINI_MODEL", previous.model]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
