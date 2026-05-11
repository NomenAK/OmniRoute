import test from "node:test";
import assert from "node:assert/strict";

const {
  applyThinkingBudget,
  setThinkingBudgetConfig,
  getThinkingBudgetConfig,
  ThinkingMode,
  EFFORT_BUDGETS,
  ADAPTIVE_BASE_BUDGET,
  DEFAULT_THINKING_CONFIG,
  THINKING_LEVEL_MAP,
  normalizeThinkingLevel,
  ensureThinkingConfig,
  hasThinkingCapableModel,
} = await import("../../open-sse/services/thinkingBudget.ts");

// ─── Config Management ──────────────────────────────────────────────────────

test("default config is adaptive (fork-local default)", () => {
  const config = getThinkingBudgetConfig();
  assert.equal(config.mode, ThinkingMode.ADAPTIVE);
});

test("setThinkingBudgetConfig updates config", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  assert.equal(getThinkingBudgetConfig().mode, ThinkingMode.AUTO);
  // Reset
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

// ─── PASSTHROUGH Mode ───────────────────────────────────────────────────────

test("PASSTHROUGH: body unchanged", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.PASSTHROUGH });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 8192 },
  };
  const result = applyThinkingBudget(body);
  assert.deepEqual(result, body);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("PASSTHROUGH: keeps reasoning_effort for OpenAI-compatible Gemini routes", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.PASSTHROUGH });
  const body = {
    model: "openai-compatible-sp-google/gemini-3.1-pro-preview",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high",
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.reasoning_effort, "high");
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

// ─── AUTO Mode ──────────────────────────────────────────────────────────────

test("AUTO: strips Claude thinking config", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 8192 },
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking, undefined);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("AUTO: strips OpenAI reasoning_effort", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  const body = {
    model: "o3-mini",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high",
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.reasoning_effort, undefined);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("AUTO: strips Gemini thinking_config", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  const body = {
    model: "gemini-2.5-pro",
    generationConfig: { thinking_config: { thinking_budget: 8192 } },
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.generationConfig.thinking_config, undefined);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

// ─── CUSTOM Mode ────────────────────────────────────────────────────────────

test("CUSTOM: sets Claude budget", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.CUSTOM, customBudget: 4096 });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 8192 },
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, 4096);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("CUSTOM: sets OpenAI reasoning_effort from budget", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.CUSTOM, customBudget: 131072 });
  const body = {
    model: "o3-mini",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "low",
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.reasoning_effort, "xhigh");
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("CUSTOM: budget 0 disables Claude thinking", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.CUSTOM, customBudget: 0 });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 8192 },
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.type, "disabled");
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

// ─── ADAPTIVE Mode ──────────────────────────────────────────────────────────

test("ADAPTIVE: simple request gets ADAPTIVE_BASE_BUDGET", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE, effortLevel: "medium" });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 8192 },
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, ADAPTIVE_BASE_BUDGET);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: ignores effortLevel (decoupled from EFFORT_BUDGETS)", () => {
  // effortLevel only matters for CUSTOM mode now; adaptive uses ADAPTIVE_BASE_BUDGET
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE, effortLevel: "high" });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, ADAPTIVE_BASE_BUDGET);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: complex request (many messages + tools) scales up from base", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  const messages = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(3000),
  }));
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool${i}` }));
  const body = {
    model: "claude-sonnet-4-20250514",
    messages,
    tools,
    thinking: { type: "enabled", budget_tokens: 1000 },
  };
  const result = applyThinkingBudget(body);
  // multiplier = 1.0 + 0.5 (msgs>10) + 0.5 (tools>3) + 0.3 (lastMsg>2000) = 2.3
  // 4096 * 2.3 = 9420
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 2.3));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: tool_use block in last 5 messages adds +0.3 multiplier", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      },
    ],
  };
  const result = applyThinkingBudget(body);
  // multiplier = 1.0 + 0.3 (tool_use)
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 1.3));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: OpenAI-shape tool_calls also count as tool_use signal", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  const body = {
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "fix" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
    ],
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 1.3));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: tool_result with is_error=true adds +0.2 multiplier", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "permission denied" },
        ],
      },
    ],
  };
  const result = applyThinkingBudget(body);
  // multiplier = 1.0 + 0.3 (tool_use in last 5) + 0.2 (error tool_result) = 1.5
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 1.5));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: tool_result with 'Error' text content adds +0.2 multiplier (no is_error flag)", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "run" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "Error: cannot read file" }],
          },
        ],
      },
    ],
  };
  const result = applyThinkingBudget(body);
  // multiplier = 1.0 + 0.2 (error text in tool_result)
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 1.2));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: signals stack (msgs>10 + tools>3 + tool_use + tool_result error)", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  // Last user message is the tool_result (content array, ~80 chars JSON) →
  // lastMsgLength<2000, so that signal does NOT fire.
  // Active signals: msgs>10 (+0.5), tools>3 (+0.5), tool_use (+0.3),
  //                 tool_result is_error (+0.2). Total = 2.5×
  const messages = [
    ...Array.from({ length: 15 }, () => ({ role: "user" as const, content: "x".repeat(500) })),
    {
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "err" }],
    },
  ];
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool${i}` }));
  const body = { model: "claude-opus-4-7", messages, tools };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 2.5));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("ADAPTIVE: all 5 signals fire → max multiplier 2.8 (long string user last)", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE });
  // Force lastMsgLength>2000 by making the LAST user message a long string
  // (after a tool_use roundtrip).
  const messages = [
    ...Array.from({ length: 12 }, () => ({ role: "user" as const, content: "x".repeat(100) })),
    {
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "fail" }],
    },
    { role: "user" as const, content: "y".repeat(3000) }, // pushes lastMsgLength>2000
  ];
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool${i}` }));
  const body = { model: "claude-opus-4-7", messages, tools };
  const result = applyThinkingBudget(body);
  // multiplier = 1 + 0.5 + 0.5 + 0.3 + 0.3 + 0.2 = 2.8
  assert.equal(result.thinking.budget_tokens, Math.ceil(ADAPTIVE_BASE_BUDGET * 2.8));
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

test("null/undefined body returns as-is", () => {
  assert.equal(applyThinkingBudget(null), null);
  assert.equal(applyThinkingBudget(undefined), undefined);
});

test("EFFORT_BUDGETS has expected keys", () => {
  assert.ok(EFFORT_BUDGETS.none === 0);
  assert.ok(EFFORT_BUDGETS.low > 0);
  assert.ok(EFFORT_BUDGETS.medium > EFFORT_BUDGETS.low);
  assert.ok(EFFORT_BUDGETS.high > EFFORT_BUDGETS.medium);
});

// ─── thinkingLevel String Conversion (Feature 4) ────────────────────────────

test("THINKING_LEVEL_MAP has all expected levels", () => {
  assert.equal(THINKING_LEVEL_MAP.none, 0);
  assert.equal(THINKING_LEVEL_MAP.low, 4096);
  assert.equal(THINKING_LEVEL_MAP.medium, 8192);
  assert.equal(THINKING_LEVEL_MAP.high, 24576);
});

test("normalizeThinkingLevel: converts thinkingLevel 'high' to budget", () => {
  const body = {
    model: "claude-sonnet-4",
    thinkingLevel: "high",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = normalizeThinkingLevel(body);
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
  assert.equal(result.thinkingLevel, undefined);
});

test("normalizeThinkingLevel: converts thinking_level 'low' to budget", () => {
  const body = {
    model: "claude-sonnet-4",
    thinking_level: "low",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = normalizeThinkingLevel(body);
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 4096);
  assert.equal(result.thinking_level, undefined);
});

test("normalizeThinkingLevel: converts 'none' to disabled", () => {
  const body = { model: "claude-sonnet-4", thinkingLevel: "none" };
  const result = normalizeThinkingLevel(body);
  assert.equal(result.thinking.type, "disabled");
  assert.equal(result.thinking.budget_tokens, 0);
});

test("normalizeThinkingLevel: converts Gemini thinkingConfig.thinkingLevel", () => {
  const body = {
    model: "gemini-2.5-pro",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "high" },
    },
  };
  const result = normalizeThinkingLevel(body);
  assert.equal(result.generationConfig.thinkingConfig.thinkingBudget, 24576);
  assert.equal(result.generationConfig.thinking_config, undefined);
});

test("normalizeThinkingLevel: ignores unknown string values", () => {
  const body = { model: "claude-sonnet-4", thinkingLevel: "ultra" };
  const result = normalizeThinkingLevel(body);
  assert.equal(result.thinking, undefined); // not converted
  assert.equal(result.thinkingLevel, "ultra"); // preserved
});

// ─── -thinking Suffix Auto-Injection (Feature 5) ────────────────────────────

test("ensureThinkingConfig: auto-injects for -thinking suffix model", () => {
  const body = {
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = ensureThinkingConfig(body);
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, EFFORT_BUDGETS.medium);
});

test("ensureThinkingConfig: does NOT override existing thinking config", () => {
  const body = {
    model: "claude-opus-4-6-thinking",
    thinking: { type: "enabled", budget_tokens: 50000 },
    messages: [{ role: "user", content: "hello" }],
  };
  const result = ensureThinkingConfig(body);
  assert.equal(result.thinking.budget_tokens, 50000); // preserved
});

test("ensureThinkingConfig: does nothing for non-thinking models", () => {
  const body = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = ensureThinkingConfig(body);
  assert.equal(result.thinking, undefined);
});

test("hasThinkingCapableModel: matches -thinking suffix", () => {
  assert.ok(hasThinkingCapableModel({ model: "claude-opus-4-6-thinking" }));
  assert.ok(hasThinkingCapableModel({ model: "kimi-k2-thinking" }));
  assert.ok(hasThinkingCapableModel({ model: "custom-model-thinking" }));
});

test("applyThinkingBudget: thinkingLevel 'high' + PASSTHROUGH = converts and passes through", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.PASSTHROUGH });
  const body = {
    model: "claude-sonnet-4",
    thinkingLevel: "high",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.budget_tokens, 24576);
  assert.equal(result.thinkingLevel, undefined);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

test("applyThinkingBudget: -thinking model without config + PASSTHROUGH = auto-inject", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.PASSTHROUGH });
  const body = {
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "hello" }],
  };
  const result = applyThinkingBudget(body);
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, EFFORT_BUDGETS.medium);
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});
