import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, IncomingMessage } from "node:http";
import { sendNtfy } from "../src/ntfy.js";

/** Start a throwaway http server on an ephemeral port; returns its URL and a close() fn. */
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

test("sendNtfy: no url and no PROS_NTFY_URL env -> ok:false near-instantly, no network attempted", async () => {
  const previous = process.env.PROS_NTFY_URL;
  delete process.env.PROS_NTFY_URL;
  try {
    const start = Date.now();
    const result = await sendNtfy({ message: "hello" });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no ntfy URL/i);
    // If it had actually attempted a network call it would take much longer
    // than this (default timeout is 5000ms) -- proves the no-op short-circuit.
    assert.ok(elapsed < 200, `expected near-instant resolution, took ${elapsed}ms`);
  } finally {
    if (previous !== undefined) process.env.PROS_NTFY_URL = previous;
  }
});

test("sendNtfy: real server responding 200 -> ok:true, and the server actually received the POST body/headers", async () => {
  let receivedBody = "";
  let receivedTitle: string | undefined;
  const { url, close } = await startServer((req, body, res) => {
    receivedBody = body;
    receivedTitle = req.headers["title"] as string | undefined;
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const result = await sendNtfy({ url, title: "Test Title", message: "hello world" });
    assert.deepEqual(result, { ok: true });
    assert.equal(receivedBody, "hello world");
    assert.equal(receivedTitle, "Test Title");
  } finally {
    await close();
  }
});

test("sendNtfy: server responds 500 -> ok:false, error mentions the status", async () => {
  const { url, close } = await startServer((_req, _body, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const result = await sendNtfy({ url, message: "hello" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /500/);
  } finally {
    await close();
  }
});

test("sendNtfy: no listener at all -> resolves ok:false without throwing", async () => {
  // Port 1 is a privileged/unused port with no listener in test environments;
  // connection should be refused (or otherwise fail) promptly.
  const result = await sendNtfy({ url: "http://127.0.0.1:1", message: "hello", timeoutMs: 3000 });
  assert.equal(result.ok, false);
});

test("sendNtfy: short timeoutMs against a slow server -> aborts near the timeout, not the server's full delay", async () => {
  const { url, close } = await startServer((_req, _body, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end("too late");
    }, 2000);
  });
  try {
    const start = Date.now();
    const result = await sendNtfy({ url, message: "hello", timeoutMs: 50 });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /abort/i);
    // Should resolve close to the 50ms timeout, nowhere near the server's 2s delay.
    assert.ok(elapsed < 1000, `expected abort near 50ms, took ${elapsed}ms`);
  } finally {
    await close();
  }
});
