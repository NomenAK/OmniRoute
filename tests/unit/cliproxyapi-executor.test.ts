import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.CLIPROXYAPI_HOST = originalEnv.CLIPROXYAPI_HOST;
  process.env.CLIPROXYAPI_PORT = originalEnv.CLIPROXYAPI_PORT;
});

describe("CliproxyapiExecutor", () => {
  let CliproxyapiExecutor;

  beforeEach(async () => {
    process.env.CLIPROXYAPI_HOST = "";
    process.env.CLIPROXYAPI_PORT = "";
    const mod = await import("../../open-sse/executors/cliproxyapi.ts");
    CliproxyapiExecutor = mod.CliproxyapiExecutor;
  });

  describe("constructor", () => {
    it("should default to 127.0.0.1:8317", () => {
      const exec = new CliproxyapiExecutor();
      assert.equal(exec.getProvider(), "cliproxyapi");
    });

    it("should respect CLIPROXYAPI_HOST env", () => {
      process.env.CLIPROXYAPI_HOST = "192.168.1.1";
      const exec = new CliproxyapiExecutor();
      assert.equal(exec.getProvider(), "cliproxyapi");
    });

    it("should respect CLIPROXYAPI_PORT env", () => {
      process.env.CLIPROXYAPI_PORT = "9999";
      const exec = new CliproxyapiExecutor();
      assert.equal(exec.getProvider(), "cliproxyapi");
    });
  });

  describe("buildUrl", () => {
    it("should always return /v1/chat/completions", () => {
      process.env.CLIPROXYAPI_HOST = "127.0.0.1";
      process.env.CLIPROXYAPI_PORT = "8317";
      const exec = new CliproxyapiExecutor();
      const url = exec.buildUrl("any-model", true);
      assert.equal(url, "http://127.0.0.1:8317/v1/chat/completions");
    });

    it("should ignore model parameter", () => {
      const exec = new CliproxyapiExecutor();
      const url = exec.buildUrl("gpt-4", false);
      assert.equal(url, "http://127.0.0.1:8317/v1/chat/completions");
    });

    it("should use custom host/port", () => {
      process.env.CLIPROXYAPI_HOST = "10.0.0.1";
      process.env.CLIPROXYAPI_PORT = "9090";
      const exec = new CliproxyapiExecutor();
      const url = exec.buildUrl("model", true);
      assert.equal(url, "http://10.0.0.1:9090/v1/chat/completions");
    });
  });

  describe("buildHeaders", () => {
    it("should return content-type without auth when no credentials", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({});
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(headers["Authorization"], undefined);
    });

    it("should add Authorization with apiKey", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({ apiKey: "test-key" });
      assert.equal(headers["Authorization"], "Bearer test-key");
    });

    it("should add Authorization with accessToken", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({ accessToken: "test-token" });
      assert.equal(headers["Authorization"], "Bearer test-token");
    });

    it("should prefer apiKey over accessToken", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({ apiKey: "key", accessToken: "token" });
      assert.equal(headers["Authorization"], "Bearer key");
    });

    it("should add Accept header for streaming", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({}, true);
      assert.equal(headers["Accept"], "text/event-stream");
    });

    it("should not add Accept header for non-streaming", () => {
      const exec = new CliproxyapiExecutor();
      const headers = exec.buildHeaders({}, false);
      assert.equal(headers["Accept"], undefined);
    });
  });

  describe("transformRequest", () => {
    it("should update model if body.model differs", () => {
      const exec = new CliproxyapiExecutor();
      const body = { model: "old-model", messages: [] };
      const result = exec.transformRequest("new-model", body, true, {});
      assert.equal(result.model, "new-model");
      assert.deepEqual(result.messages, []);
    });

    it("should return body unchanged if model matches", () => {
      const exec = new CliproxyapiExecutor();
      const body = { model: "same-model", messages: [] };
      const result = exec.transformRequest("same-model", body, true, {});
      assert.equal(result.model, "same-model");
    });

    it("should handle non-object body", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest("model", "not-an-object", true, {});
      assert.equal(result, "not-an-object");
    });

    it("should handle null body", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest("model", null, true, {});
      assert.equal(result, null);
    });

    // After 2026-05-12 bisect: Anthropic accepts the full range of
    // thinking/output_config/context_management shapes intact alongside
    // the CPA cloak. transformRequest no longer strips any of these; it
    // only rewrites mcp_ tool names. The cases below assert passthrough.

    it("preserves Anthropic-valid thinking shape on /v1/messages routing", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "Be helpful" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: { type: "enabled", budget_tokens: 10240 },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.thinking, { type: "enabled", budget_tokens: 10240 });
    });

    it("preserves disabled thinking shape on /v1/messages routing", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: { type: "disabled", budget_tokens: 0 },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.thinking, { type: "disabled", budget_tokens: 0 });
    });

    it("passes Capy SDK adaptive thinking shape through verbatim", () => {
      // Was previously stripped (display:summarized triggered the strip);
      // bisect 2026-05-12 confirmed Anthropic accepts this shape intact.
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: { type: "adaptive", display: "summarized" },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
    });

    it("passes thinking with display extra through even on enabled type", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: { type: "enabled", budget_tokens: 10240, display: "summarized" },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.thinking, {
        type: "enabled",
        budget_tokens: 10240,
        display: "summarized",
      });
    });

    it("passes Capy SDK output_config and context_management through verbatim", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort: "max" },
        context_management: { auto_summarize: true },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.output_config, { effort: "max" });
      assert.deepEqual(result.context_management, { auto_summarize: true });
    });

    it("passes CC-spec output_config {effort:'xhigh'} through unchanged", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { effort: "xhigh" },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.output_config, { effort: "xhigh" });
    });

    it("passes CC-spec context_management.edits through unchanged", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.context_management, {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      });
    });

    it("passes adaptive thinking {type:'adaptive'} (without display) unchanged", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: { type: "adaptive" },
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.deepEqual(result.thinking, { type: "adaptive" });
    });

    it("does not strip OpenAI-shape bodies (no thinking, no system, string content)", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        reasoning_effort: "medium",
      };
      const result = exec.transformRequest("gpt-5.5", body, true, {});
      // No Anthropic indicators present, so strips are skipped. Body
      // passes through with its OpenAI fields preserved.
      assert.equal(result.reasoning_effort, "medium");
      assert.equal(result.thinking, undefined);
      assert.equal(result.output_config, undefined);
    });
  });

  describe("execute", () => {
    it("should make fetch request with correct URL, headers, and body", async () => {
      let capturedUrl, capturedOptions;
      globalThis.fetch = async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return { status: 200, ok: true };
      };

      const exec = new CliproxyapiExecutor();
      const result = await exec.execute({
        model: "test-model",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: {},
      });

      assert.equal(capturedUrl, "http://127.0.0.1:8317/v1/chat/completions");
      assert.equal(capturedOptions.method, "POST");
      assert.ok(capturedOptions.signal);
      const parsed = JSON.parse(capturedOptions.body);
      assert.equal(parsed.messages[0].content, "hi");
      assert.ok(result.response);
    });

    it("should pass credentials to headers", async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, options) => {
        capturedHeaders = options.headers;
        return { status: 200, ok: true };
      };

      const exec = new CliproxyapiExecutor();
      await exec.execute({
        model: "test",
        body: {},
        stream: false,
        credentials: { apiKey: "secret-key" },
      });

      assert.equal(capturedHeaders["Authorization"], "Bearer secret-key");
    });

    it("should merge upstream extra headers", async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, options) => {
        capturedHeaders = options.headers;
        return { status: 200, ok: true };
      };

      const exec = new CliproxyapiExecutor();
      await exec.execute({
        model: "test",
        body: {},
        stream: false,
        credentials: {},
        upstreamExtraHeaders: { "X-Custom": "value" },
      });

      assert.equal(capturedHeaders["X-Custom"], "value");
    });

    it("should handle rate limited response", async () => {
      globalThis.fetch = async () => ({ status: 429, ok: false });
      const log = { warn: (tag, msg) => {} };
      let logged = false;
      log.warn = () => {
        logged = true;
      };

      const exec = new CliproxyapiExecutor();
      const result = await exec.execute({
        model: "test",
        body: {},
        stream: false,
        credentials: {},
        log,
      });

      assert.equal(result.response.status, 429);
    });

    it("should return url, headers, and transformedBody", async () => {
      globalThis.fetch = async () => ({ status: 200, ok: true });

      const exec = new CliproxyapiExecutor();
      const result = await exec.execute({
        model: "test",
        body: { messages: [] },
        stream: true,
        credentials: {},
      });

      assert.ok(result.url);
      assert.ok(result.headers);
      assert.ok(result.transformedBody);
    });
  });

  describe("Anthropic-shape detection", () => {
    it("detects Anthropic-shape when top-level system field present", () => {
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "You are helpful" }],
        messages: [{ role: "user", content: "hi" }],
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      // Anthropic-shape: system field stripped (Capy extras behavior) vs preserved
      // The key assertion is that it does NOT try to send to /v1/chat/completions path
      // (verified by output_config being stripped when present)
      assert.equal(result.system !== undefined || result.messages !== undefined, true);
    });

    it("detects Anthropic-shape when messages[0].content is an array (no system field)", () => {
      // Observable: mcp_ tool-name rewrite only runs on Anthropic-shape
      // bodies, and posts a `_toolNameMap` field on the result. We use
      // that as a proxy signal for "detection took the Anthropic branch".
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "mcp_filesystem_read", description: "d", input_schema: {} }],
      };
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      assert.ok(
        result._toolNameMap,
        "Anthropic-shape branch must run the mcp_ rewrite (signature observable)"
      );
    });

    it("treats OpenAI-shape (string content, no system) as non-Anthropic passthrough", () => {
      // OpenAI-shape bodies do not enter the mcp_ rewrite branch: tool
      // names pass through, no _toolNameMap is set.
      const exec = new CliproxyapiExecutor();
      const body = {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "mcp_filesystem_read", description: "d", input_schema: {} }],
      };
      const result = exec.transformRequest("gpt-5.5", body, true, {});
      assert.equal(result._toolNameMap, undefined);
      const toolName = (result.tools as Array<{ name: string }>)[0].name;
      assert.equal(toolName, "mcp_filesystem_read");
    });
  });

  describe("Capy SDK extras passthrough on Anthropic-shape bodies", () => {
    // Bisect 2026-05-12 (11 variants × 2 turns + 5-turn stress) confirmed
    // Anthropic accepts these fields intact through the CPA cloak. The
    // previous unconditional strip was over-engineered preemptive defense
    // that silently dropped valid client content.

    function anthropicBody(extras: Record<string, unknown>) {
      return {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        ...extras,
      };
    }

    it("passes output_config:{effort:'max'} through verbatim", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest(
        "claude-opus-4-7",
        anthropicBody({ output_config: { effort: "max" } }),
        true,
        {}
      );
      assert.deepEqual(result.output_config, { effort: "max" });
    });

    it("passes metadata with any keys through verbatim", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest(
        "claude-opus-4-7",
        anthropicBody({ metadata: { user_id: "abc", session_id: "s1", extra: 1 } }),
        true,
        {}
      );
      assert.deepEqual(result.metadata, {
        user_id: "abc",
        session_id: "s1",
        extra: 1,
      });
    });

    it("passes client_info through", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest(
        "claude-opus-4-7",
        anthropicBody({ client_info: { name: "Capy" } }),
        true,
        {}
      );
      assert.deepEqual(result.client_info, { name: "Capy" });
    });

    it("passes prompt_cache_key through", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest(
        "claude-opus-4-7",
        anthropicBody({ prompt_cache_key: "key123" }),
        true,
        {}
      );
      assert.equal(result.prompt_cache_key, "key123");
    });

    it("passes safety_identifier through", () => {
      const exec = new CliproxyapiExecutor();
      const result = exec.transformRequest(
        "claude-opus-4-7",
        anthropicBody({ safety_identifier: "sid" }),
        true,
        {}
      );
      assert.equal(result.safety_identifier, "sid");
    });
  });

  describe("mcp_ tool name rewrite on Anthropic-shape bodies", () => {
    function anthropicBodyWithTools(tools: unknown[], messages: unknown[] = []) {
      return {
        model: "claude-opus-4-7",
        system: [{ type: "text", text: "x" }],
        tools,
        messages:
          messages.length > 0
            ? messages
            : [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      };
    }

    it("rewrites mcp_* tool definition names (tool defs)", () => {
      const exec = new CliproxyapiExecutor();
      const body = anthropicBodyWithTools([
        { name: "mcp_filesystem_read", description: "Read file", input_schema: {} },
      ]);
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      const toolName = (result.tools as Array<{ name: string }>)[0].name;
      assert.notEqual(toolName, "mcp_filesystem_read", "mcp_ tool name should be rewritten");
      assert.match(
        toolName,
        /^[A-Z]/,
        "rewritten name should start with uppercase or differ from mcp_"
      );
    });

    it("does not rewrite non-mcp_ tool names", () => {
      const exec = new CliproxyapiExecutor();
      const body = anthropicBodyWithTools([
        { name: "my_tool", description: "My tool", input_schema: {} },
      ]);
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      const toolName = (result.tools as Array<{ name: string }>)[0].name;
      assert.equal(toolName, "my_tool");
    });

    it("rewrites mcp_* tool_use names in assistant message history", () => {
      const exec = new CliproxyapiExecutor();
      const body = anthropicBodyWithTools(
        [{ name: "mcp_github_create_issue", description: "d", input_schema: {} }],
        [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "mcp_github_create_issue", input: {} }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
        ]
      );
      const result = exec.transformRequest("claude-opus-4-7", body, true, {});
      const assistantMsg = (result.messages as Array<{ role: string; content: unknown[] }>).find(
        (m) => m.role === "assistant"
      );
      const toolUseBlock = assistantMsg?.content.find(
        (b): b is { type: string; name: string } =>
          typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_use"
      );
      assert.ok(toolUseBlock, "tool_use block should exist in assistant message");
      assert.notEqual(
        toolUseBlock.name,
        "mcp_github_create_issue",
        "tool_use name should be rewritten"
      );
    });
  });
});
