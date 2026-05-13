import { test } from "node:test";
import assert from "node:assert/strict";

import { getModelInfoCore } from "../../../open-sse/services/model.ts";

// C.2 — Failing tests for gpt-5.3-codex → cx/gpt-5.5 alias
// The Codex beta name gpt-5.3-codex shipped publicly as gpt-5.5.
// User decision: alias bare and cx-prefixed forms to cx/gpt-5.5.
// gh/ and cu/ prefixes must keep the literal id.

test("gpt-5.3-codex (bare) resolves to codex provider with gpt-5.5 without ambiguity", async () => {
  const resolved = await getModelInfoCore("gpt-5.3-codex", {});
  // Must not be flagged ambiguous — alias must pre-empt multi-provider lookup
  assert.notEqual(
    resolved.errorType,
    "ambiguous_model",
    "bare gpt-5.3-codex must not be flagged ambiguous"
  );
  // codex is the canonical provider id; cx is its alias
  assert.equal(resolved.provider, "codex", "must pick the Codex provider");
  assert.equal(resolved.model, "gpt-5.5", "must alias to gpt-5.5");
});

test("cx/gpt-5.3-codex resolves to codex/gpt-5.5", async () => {
  const resolved = await getModelInfoCore("cx/gpt-5.3-codex", {});
  assert.equal(resolved.provider, "codex", "cx prefix resolves to codex provider id");
  assert.equal(resolved.model, "gpt-5.5", "cx/gpt-5.3-codex must alias to gpt-5.5");
});

test("gh/gpt-5.3-codex remains GitHub-routed (alias only collapses bare/cx forms)", async () => {
  const resolved = await getModelInfoCore("gh/gpt-5.3-codex", {});
  assert.equal(resolved.provider, "github", "gh prefix routes to github provider");
  // gh path keeps the literal model id — only bare/cx form aliases to 5.5
  assert.equal(resolved.model, "gpt-5.3-codex", "gh/gpt-5.3-codex must keep literal model id");
});
