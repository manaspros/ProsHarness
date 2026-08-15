import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, IncomingMessage } from "node:http";
import { wireNtfyNotifications, type ParkedNotificationInfo } from "../src/wire-barrier.js";

/** A tiny fake mirroring Barrier.onParked's shape, without any real Barrier/journal/guardian. */
class FakeParkedSource {
  private listeners: Array<(info: ParkedNotificationInfo) => void> = [];
  onParked(cb: (info: ParkedNotificationInfo) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  fire(info: ParkedNotificationInfo): void {
    for (const l of this.listeners) l(info);
  }
}

async function startServer(
  handler: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
  const url = `http://127.0.0.1:${address.port}/topic`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("wireNtfyNotifications: a guaranteed-unreachable ntfy target never blocks fire(), and the failure is observable via onResult", async () => {
  const source = new FakeParkedSource();
  let result: { ok: boolean; error?: string } | undefined;
  wireNtfyNotifications(source, {
    url: "http://127.0.0.1:1", // nothing listens here
    onResult: (_info, r) => {
      result = r;
    },
  });

  const start = Date.now();
  source.fire({
    runId: "run-1",
    checkpointId: "cp-1",
    questionId: "q-1",
    gateType: "ask_human",
    prompt: "continue?",
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `fire() must return near-instantly; took ${elapsed}ms`);

  await waitFor(() => result !== undefined, 3000);
  assert.equal(result?.ok, false);
});

test("wireNtfyNotifications: success path against a real server, sensible messages for ask_human and plan_approval", async () => {
  const received: Array<{ title?: string; body: string }> = [];
  const { url, close } = await startServer((req, body, res) => {
    received.push({ title: req.headers["title"] as string | undefined, body });
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const source = new FakeParkedSource();
    const results: Array<{ info: ParkedNotificationInfo; result: { ok: boolean; error?: string } }> = [];
    wireNtfyNotifications(source, {
      url,
      onResult: (info, result) => results.push({ info, result }),
    });

    source.fire({
      runId: "run-ask",
      checkpointId: "cp-ask",
      questionId: "q-ask",
      gateType: "ask_human",
      prompt: "Should we proceed with the migration?",
    });
    source.fire({
      runId: "run-plan",
      checkpointId: "cp-plan",
      questionId: "q-plan",
      gateType: "plan_approval",
      prompt: "Plan ready for review",
      planRef: { planId: "plan-42", version: 3 },
    });

    await waitFor(() => results.length === 2, 3000);
    for (const r of results) assert.equal(r.result.ok, true);

    assert.equal(received.length, 2);
    const askMsg = received.find((r) => r.body.includes("proceed with the migration"));
    const planMsg = received.find((r) => r.body.includes("plan-42"));
    assert.ok(askMsg, "ask_human message should include the question prompt");
    assert.ok(planMsg, "plan_approval message should include the planId");
    assert.match(planMsg!.body, /v3/);
    assert.match(askMsg!.title ?? "", /question/i);
    assert.match(planMsg!.title ?? "", /Gate 1|plan/i);
    assert.notEqual(askMsg!.title, planMsg!.title);
  } finally {
    await close();
  }
});

test("wireNtfyNotifications: the returned unsubscribe function stops further fires from triggering sendNtfy", async () => {
  const source = new FakeParkedSource();
  let onResultCalls = 0;
  const unsubscribe = wireNtfyNotifications(source, {
    url: "http://127.0.0.1:1",
    onResult: () => {
      onResultCalls += 1;
    },
  });

  source.fire({
    runId: "run-1",
    checkpointId: "cp-1",
    questionId: "q-1",
    gateType: "ask_human",
    prompt: "first",
  });
  await waitFor(() => onResultCalls === 1, 3000);

  unsubscribe();
  source.fire({
    runId: "run-2",
    checkpointId: "cp-2",
    questionId: "q-2",
    gateType: "ask_human",
    prompt: "second, should not trigger a notification",
  });

  // Give plenty of time for a would-be (but unsubscribed) call to have fired.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(onResultCalls, 1, "no further onResult calls after unsubscribe");
});
