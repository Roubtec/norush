/**
 * Integration tests against real provider APIs.
 *
 * These tests only run when the corresponding API key environment variable
 * is set. They submit tiny batches (1-2 requests) with cheap models and
 * short prompts.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY — enables Claude integration test.
 *   OPENAI_API_KEY    — enables OpenAI integration test.
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { createNorush } from "../../norush.js";
import type { Result, Request } from "../../types.js";
import { ClaudeAdapter } from "../../providers/claude.js";
import { OpenAIBatchAdapter } from "../../providers/openai-batch.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
// Claude integration
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Claude integration (real API)", () => {
  it("submits and retrieves a tiny batch", async () => {
    const store = new MemoryStore();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by skipIf
    const adapter = new ClaudeAdapter({ apiKey: ANTHROPIC_API_KEY! });

    const engine = createNorush({
      store,
      providers: new Map([["claude", adapter]]),
    });

    const delivered: Array<{ result: Result; request: Request }> = [];
    engine.addDeliveryCallback(async (result, request) => {
      delivered.push({ result, request });
    });

    // Enqueue a single cheap request.
    const req = await engine.enqueue({
      provider: "claude",
      model: "claude-haiku-4-20250929",
      params: {
        max_tokens: 50,
        messages: [{ role: "user", content: "Say hi in one word." }],
      },
      userId: "integration-test",
    });

    expect(req.id).toBeDefined();
    expect(req.status).toBe("queued");

    // Flush to submit the batch.
    await engine.flush();

    // Poll until completion (with timeout).
    const maxWaitMs = 120_000; // 2 minutes
    const pollIntervalMs = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await engine.tick();

      // Check if the request has been completed.
      const updatedReq = await store.getRequest(req.id);
      if (updatedReq && (updatedReq.status === "succeeded" || updatedReq.status === "failed")) {
        break;
      }

      // Wait for async pipeline to process.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check again after pipeline processing.
      const recheckedReq = await store.getRequest(req.id);
      if (recheckedReq && (recheckedReq.status === "succeeded" || recheckedReq.status === "failed")) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Deliver results.
    await engine.tick();

    const finalReq = await store.getRequest(req.id);
    expect(finalReq).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked above
    expect(finalReq!.status).toBe("succeeded");

    await engine.stop();
  }, 180_000); // 3 minute timeout
});

// ---------------------------------------------------------------------------
// OpenAI integration
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI integration (real API)", () => {
  it("submits and retrieves a tiny batch", async () => {
    const store = new MemoryStore();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by skipIf
    const adapter = new OpenAIBatchAdapter({ apiKey: OPENAI_API_KEY! });

    const engine = createNorush({
      store,
      providers: new Map([["openai", adapter]]),
    });

    const delivered: Array<{ result: Result; request: Request }> = [];
    engine.addDeliveryCallback(async (result, request) => {
      delivered.push({ result, request });
    });

    // Enqueue a single cheap request.
    const req = await engine.enqueue({
      provider: "openai",
      model: "gpt-4o-mini",
      params: {
        max_tokens: 50,
        messages: [{ role: "user", content: "Say hi in one word." }],
      },
      userId: "integration-test",
    });

    expect(req.id).toBeDefined();
    expect(req.status).toBe("queued");

    // Flush to submit the batch.
    await engine.flush();

    // Poll until completion (with timeout).
    const maxWaitMs = 120_000; // 2 minutes
    const pollIntervalMs = 10_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await engine.tick();

      const updatedReq = await store.getRequest(req.id);
      if (updatedReq && (updatedReq.status === "succeeded" || updatedReq.status === "failed")) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const recheckedReq = await store.getRequest(req.id);
      if (recheckedReq && (recheckedReq.status === "succeeded" || recheckedReq.status === "failed")) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Deliver results.
    await engine.tick();

    const finalReq = await store.getRequest(req.id);
    expect(finalReq).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked above
    expect(finalReq!.status).toBe("succeeded");

    await engine.stop();
  }, 180_000); // 3 minute timeout
});
