import { test } from "node:test";
import assert from "node:assert/strict";
// selfFetchWithRetry is not yet exported — this import will fail (TDD: failing test)
import { selfFetchWithRetry } from "../../../src/app/api/providers/[id]/sync-models/route.ts";

// ---------------------------------------------------------------------------
// Test 1: retry succeeds on attempt 3
// ---------------------------------------------------------------------------
test("self-fetch retries with backoff and succeeds on attempt 3", async () => {
  let attempts = 0;
  const fetchMock: typeof fetch = async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error("fetch failed");
    }
    return new Response(JSON.stringify({ models: [{ id: "model-1" }] }), { status: 200 });
  };

  let inProcCalls = 0;
  const inProcMock = async () => {
    inProcCalls++;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  };

  const result = await selfFetchWithRetry("http://127.0.0.1:20128/api/providers/conn-1/models", {
    fetch: fetchMock,
    maxRetries: 5,
    backoffMs: 5,
    inProcessFallback: inProcMock,
  });

  assert.equal(attempts, 3, "should have retried twice before succeeding on attempt 3");
  assert.equal(inProcCalls, 0, "should not have called in-process route");
  assert.equal(result.ok, true, "response should be ok");
});

// ---------------------------------------------------------------------------
// Test 2: falls back to in-process after maxRetries failures
// ---------------------------------------------------------------------------
test("self-fetch falls back to in-process route after maxRetries failures", async () => {
  let attempts = 0;
  const fetchMock: typeof fetch = async () => {
    attempts++;
    throw new Error("fetch failed");
  };

  let inProcCalls = 0;
  const inProcMock = async () => {
    inProcCalls++;
    return new Response(JSON.stringify({ models: [{ id: "in-proc-model" }] }), { status: 200 });
  };

  const result = await selfFetchWithRetry("http://127.0.0.1:20128/api/providers/conn-2/models", {
    fetch: fetchMock,
    maxRetries: 3,
    backoffMs: 5,
    connectionId: "conn-2",
    inProcessFallback: inProcMock,
  });

  assert.equal(attempts, 3, "should retry exactly maxRetries times");
  assert.equal(inProcCalls, 1, "should fall back to in-process exactly once");
  const body = await result.json();
  assert.equal(body.models[0].id, "in-proc-model");
});

// ---------------------------------------------------------------------------
// Test 3: HTTP error responses are returned as-is (no retry on HTTP errors)
//
// Retry contract: only network-level failures (ECONNREFUSED, "fetch failed")
// are retried — these indicate the loopback listener is not yet up.
// HTTP responses (even 4xx/5xx) mean the server IS up and returned an error
// that should be propagated as-is to the caller.
// ---------------------------------------------------------------------------
test("self-fetch returns HTTP error responses immediately without retrying", async () => {
  // 5xx HTTP response: server is up but returned error — return immediately, no retry
  {
    let attempts = 0;
    const fetchMock: typeof fetch = async () => {
      attempts++;
      return new Response("server error", { status: 503 });
    };
    const inProcMock = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });

    const res = await selfFetchWithRetry("http://127.0.0.1:20128/api/providers/conn-3/models", {
      fetch: fetchMock,
      maxRetries: 5,
      backoffMs: 5,
      inProcessFallback: inProcMock,
    });

    assert.equal(
      attempts,
      1,
      `5xx HTTP response means server is up — should NOT retry (got ${attempts})`
    );
    assert.equal(res.status, 503, "should propagate the 503 response as-is");
  }

  // 4xx HTTP response: also returned immediately without retry
  {
    let attempts = 0;
    const fetchMock: typeof fetch = async () => {
      attempts++;
      return new Response("not found", { status: 404 });
    };
    const inProcMock = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });

    const res = await selfFetchWithRetry("http://127.0.0.1:20128/api/providers/conn-4/models", {
      fetch: fetchMock,
      maxRetries: 5,
      backoffMs: 5,
      inProcessFallback: inProcMock,
    });

    assert.equal(
      attempts,
      1,
      `4xx HTTP response means server is up — should NOT retry (got ${attempts})`
    );
    assert.equal(res.status, 404, "should propagate the 404 response as-is");
  }
});
