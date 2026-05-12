/**
 * Thinking Budget Control — Phase 2
 *
 * Provides proxy-level control over AI thinking/reasoning budgets.
 * Modes: auto, passthrough, custom, adaptive
 */

// Thinking budget modes
export const ThinkingMode = {
  AUTO: "auto", // Let provider decide (remove client's budget)
  PASSTHROUGH: "passthrough", // No changes (current behavior)
  CUSTOM: "custom", // Set fixed budget
  ADAPTIVE: "adaptive", // Scale based on request complexity
};

import {
  capThinkingBudget,
  getDefaultThinkingBudget,
  getResolvedModelCapabilities,
  supportsReasoning,
} from "@/lib/modelCapabilities";

// Effort → budget token mapping (legacy; kept for backward compat with CUSTOM
// reverse-mapping and OpenAI bucket fallbacks). Adaptive uses
// EFFORT_BASELINES (below) for its tier-scaled starting points.
export const EFFORT_BUDGETS = {
  none: 0,
  low: 1024,
  medium: 10240,
  high: 131072, // Handled globally by capThinkingBudget later
  max: 131072, // T11: Claude "max" / "xhigh" — full budget
  xhigh: 131072, // T11: explicit alias used internally
};

// 5-tier effort baselines used by ADAPTIVE mode. The starting budget for
// each tier is multiplied by the adaptive signal multiplier (1.0×–2.8×)
// then capped by the per-model thinkingBudgetCap. Anthropic accepts the
// same 5 labels in CC wire-image `output_config.effort`, so adaptive
// emits BOTH the tier label AND the computed budget_tokens.
export const EFFORT_BASELINES: Record<string, number> = {
  none: 0,
  low: 2048,
  medium: 6144,
  high: 16384,
  xhigh: 32768,
  max: 65536, // Subject to model cap
};

// Legacy export kept for any imports — adaptive default tier is medium.
export const ADAPTIVE_BASE_BUDGET = EFFORT_BASELINES.medium;

/**
 * Map a numeric budget back to the closest CC-spec effort label.
 * Used to emit output_config.effort alongside thinking.budget_tokens.
 * Wire-spec only includes low/medium/high/xhigh — "max" is a settings
 * label that maps to "xhigh" on the wire (Anthropic CC + OpenAI both
 * top out at xhigh).
 */
export function budgetToEffortTier(budget: number): string {
  if (budget <= 0) return "none";
  if (budget <= EFFORT_BASELINES.low) return "low";
  if (budget <= EFFORT_BASELINES.medium) return "medium";
  if (budget <= EFFORT_BASELINES.high) return "high";
  return "xhigh";
}

// thinkingLevel string → budget token mapping
// Used when clients send string-based thinking levels (e.g., VS Code Copilot)
export const THINKING_LEVEL_MAP = {
  none: 0,
  low: 4096,
  medium: 8192,
  high: 24576,
  max: 131072, // T11: max = full Claude budget (sub2api: xhigh)
  xhigh: 131072, // T11: explicit xhigh alias
};

// Default config: adaptive mode injects a sensible thinking budget on
// thinking-capable models when the client sends nothing or sends an
// invalid shape (e.g. Capy's {type:"adaptive", display:"summarized"}).
// Fork-local default. Upstream OmniRoute ships with PASSTHROUGH.
export const DEFAULT_THINKING_CONFIG = {
  mode: ThinkingMode.ADAPTIVE,
  customBudget: 10240,
  effortLevel: "medium",
};

// In-memory config anchored on globalThis via Symbol.for so all Next.js
// bundles (server, edge, route handlers, open-sse handlers) share the
// same instance. Otherwise each bundle gets its own module-level _config
// and updates made via the settings API or startup hydration are
// invisible to applyThinkingBudget when called from a different bundle.
const _CONFIG_KEY = Symbol.for("omniroute.thinkingBudget._config");
type ThinkingConfig = { mode: string; customBudget: number; effortLevel: string };

function _getConfig(): ThinkingConfig {
  const g = globalThis as unknown as Record<symbol, ThinkingConfig>;
  if (!g[_CONFIG_KEY]) g[_CONFIG_KEY] = { ...DEFAULT_THINKING_CONFIG };
  return g[_CONFIG_KEY];
}

/**
 * Set the thinking budget config (called from settings API or startup)
 */
export function setThinkingBudgetConfig(config) {
  const g = globalThis as unknown as Record<symbol, ThinkingConfig>;
  g[_CONFIG_KEY] = { ...DEFAULT_THINKING_CONFIG, ...config };
}

/**
 * Get current thinking budget config
 */
export function getThinkingBudgetConfig() {
  return { ..._getConfig() };
}

/**
 * Normalize thinkingLevel string fields into numeric budget.
 * Handles: body.thinkingLevel, body.thinking_level,
 * and Gemini's generationConfig.thinkingConfig.thinkingLevel
 *
 * @param {object} body - Request body
 * @returns {object} Body with string thinkingLevel converted to numeric budget
 */
export function normalizeThinkingLevel(body) {
  if (!body || typeof body !== "object") return body;
  const result = { ...body };

  // Handle top-level thinkingLevel or thinking_level string fields
  const levelStr = result.thinkingLevel || result.thinking_level;
  if (typeof levelStr === "string" && THINKING_LEVEL_MAP[levelStr.toLowerCase()] !== undefined) {
    const rawBudget = THINKING_LEVEL_MAP[levelStr.toLowerCase()];
    const budget = capThinkingBudget(result.model || "", rawBudget);
    // Convert to Claude thinking format as canonical representation
    result.thinking = {
      type: budget > 0 ? "enabled" : "disabled",
      budget_tokens: budget,
    };
    delete result.thinkingLevel;
    delete result.thinking_level;
  }

  // Handle Gemini's generationConfig.thinkingConfig.thinkingLevel
  const geminiLevel =
    result.generationConfig?.thinkingConfig?.thinkingLevel ||
    result.generationConfig?.thinking_config?.thinkingLevel;
  if (
    typeof geminiLevel === "string" &&
    THINKING_LEVEL_MAP[geminiLevel.toLowerCase()] !== undefined
  ) {
    const rawBudget = THINKING_LEVEL_MAP[geminiLevel.toLowerCase()];
    const budget = capThinkingBudget(result.model || "", rawBudget);
    result.generationConfig = {
      ...result.generationConfig,
      thinkingConfig: { ...result.generationConfig.thinkingConfig, thinkingBudget: budget },
    };
    // Clean up string variants
    if (result.generationConfig.thinkingConfig) {
      delete result.generationConfig.thinkingConfig.thinkingLevel;
    }
    if (result.generationConfig.thinking_config) {
      delete result.generationConfig.thinking_config;
    }
  }

  return result;
}

/**
 * Ensure models with -thinking suffix have thinking config injected.
 * Prevents 400 errors from Claude API when thinking params are missing.
 *
 * @param {object} body - Request body
 * @returns {object} Body with thinking config auto-injected if needed
 */
export function ensureThinkingConfig(body) {
  if (!body || typeof body !== "object") return body;
  const model = body.model || "";

  // Only auto-inject for models with -thinking suffix
  if (!model.endsWith("-thinking")) return body;

  // If thinking config already present, don't override
  if (body.thinking) return body;

  const result = { ...body };
  result.thinking = {
    type: "enabled",
    budget_tokens: getDefaultThinkingBudget(model) || EFFORT_BUDGETS.medium,
  };
  return result;
}

/**
 * Apply thinking budget control to a request body.
 * Called before format-specific translation.
 *
 * Pipeline: normalizeThinkingLevel → ensureThinkingConfig → mode processing
 *
 * @param {object} body - Request body (supported formats)
 * @param {object} [config] - Override config (defaults to stored config)
 * @returns {object} Modified body
 */
export function applyThinkingBudget(body, config = null) {
  const cfg = config || _getConfig();
  if (!body || typeof body !== "object") return body;

  // Early exit: strip ALL reasoning/thinking params for models that don't support them.
  // Provider-specific Cloud Code restrictions should be handled at the executor boundary.
  const modelStr = typeof body.model === "string" ? body.model : "";
  if (modelStr && !supportsReasoning(modelStr)) {
    return stripThinkingConfig(body);
  }

  // Pre-processing: convert string thinkingLevel to numeric budget
  let processed = normalizeThinkingLevel(body);

  // Pre-processing: auto-inject thinking config for -thinking suffix models
  processed = ensureThinkingConfig(processed);

  switch (cfg.mode) {
    case ThinkingMode.AUTO:
      return stripThinkingConfig(processed);

    case ThinkingMode.PASSTHROUGH:
      return processed;

    case ThinkingMode.CUSTOM:
      return setCustomBudget(processed, cfg.customBudget);

    case ThinkingMode.ADAPTIVE:
      return applyAdaptiveBudget(processed, cfg);

    default:
      return processed;
  }
}

/**
 * AUTO mode: strip all thinking configuration, let provider decide
 */
function stripThinkingConfig(body) {
  const result = { ...body };

  // Claude format
  delete result.thinking;

  // OpenAI format
  delete result.reasoning_effort;
  delete result.reasoning;

  // Gemini format
  if (result.generationConfig) {
    result.generationConfig = { ...result.generationConfig };
    delete result.generationConfig.thinking_config;
    delete result.generationConfig.thinkingConfig;
  }

  return result;
}

/**
 * Detect whether a body is in OpenAI/Codex Responses API shape.
 * Indicators (any one is decisive):
 *   - `_nativeCodexPassthrough` marker (set by chatCore for codex routes)
 *   - `input` array (Responses API uses `input`, not `messages`)
 *   - `instructions` string (Responses API top-level system prompt)
 *   - `reasoning` object (`{effort, summary}` — Responses API shape)
 *   - `reasoning_effort` string (Chat Completions reasoning hint)
 *
 * Anthropic `thinking` and CC wire-image `output_config` fields must NOT
 * be injected into these bodies — Codex returns 400 "Unsupported parameter:
 * thinking". OpenAI Chat Completions ignores them but they still leak
 * Anthropic-only fields to non-Anthropic providers (DeepSeek, etc).
 */
function isOpenAIShape(body: Record<string, unknown>): boolean {
  if (body._nativeCodexPassthrough === true) return true;
  if (Array.isArray(body.input)) return true;
  if (typeof body.instructions === "string") return true;
  if (body.reasoning && typeof body.reasoning === "object") return true;
  if (typeof body.reasoning_effort === "string") return true;
  return false;
}

/**
 * CUSTOM mode: set exact budget tokens. Shape-aware emission:
 *   - Anthropic-shape bodies → emit `thinking` + `output_config` (CC wire-image)
 *   - OpenAI/Codex-shape bodies → emit `reasoning_effort` / `reasoning.effort` only
 *
 * Pre-rebase, this function unconditionally injected Anthropic-shape fields
 * whenever the model was thinking-capable, which broke GPT-5.5 routes
 * (Codex returns 400 "Unsupported parameter: thinking"). The shape check
 * keeps each provider's body clean.
 */
function setCustomBudget(body, budget) {
  const result = { ...body } as Record<string, unknown>;
  const effortTier = budgetToEffortTier(budget);
  const isOAI = isOpenAIShape(result);

  if (isOAI) {
    // OpenAI/Codex Responses or Chat Completions reasoning_effort mapping.
    // Codex accepts low/medium/high (not xhigh/max — those are CC-only labels).
    // Strip any leaked Anthropic-shape fields from upstream code paths.
    delete result.thinking;
    delete result.output_config;

    const oaiEffort =
      effortTier === "none"
        ? "low"
        : effortTier === "xhigh" || effortTier === "max"
          ? "high"
          : effortTier;

    if (budget <= 0) {
      delete result.reasoning_effort;
      delete result.reasoning;
    } else if (result.reasoning && typeof result.reasoning === "object") {
      result.reasoning = { ...(result.reasoning as Record<string, unknown>), effort: oaiEffort };
    } else if (result.reasoning_effort !== undefined || result._nativeCodexPassthrough === true) {
      result.reasoning_effort = oaiEffort;
    }
  } else {
    // Anthropic-shape body. Emit CC wire-image fields (thinking + output_config).
    if (result.thinking || hasThinkingCapableModel(result)) {
      result.thinking = {
        type: budget > 0 ? "enabled" : "disabled",
        budget_tokens: budget,
      };
    }
    if (budget > 0 && (result.thinking || hasThinkingCapableModel(result))) {
      const oc =
        result.output_config && typeof result.output_config === "object"
          ? { ...(result.output_config as Record<string, unknown>) }
          : {};
      oc.effort = effortTier === "none" ? "low" : effortTier;
      result.output_config = oc;
    }
  }

  // Gemini thinking_config (applies regardless of OAI/Anthropic shape)
  const gen = (result as { generationConfig?: Record<string, unknown> }).generationConfig;
  if (gen?.thinking_config || gen?.thinkingConfig) {
    result.generationConfig = {
      ...gen,
      thinking_config: { thinking_budget: budget },
    };
  }

  return result;
}

/**
 * ADAPTIVE mode: scale budget based on the requested effort tier +
 * complexity signals.
 *
 * Effort tier priority:
 *   1. body.output_config.effort (CC wire-image input)
 *   2. cfg.effortLevel (settings UI)
 *   3. "medium" (default)
 *
 * Tier baselines (EFFORT_BASELINES): low=2K, medium=6K, high=16K,
 * xhigh=32K, max=64K. Then signals stack a multiplier on top.
 *
 * Signals (cumulative multiplier on top of base 1.0):
 *   - messageCount > 10                          → +0.5  (long conversation)
 *   - toolCount > 3                              → +0.5  (tool-heavy session)
 *   - lastMsgLength > 2000                       → +0.3  (verbose last user turn)
 *   - tool_use blocks in last 5 messages         → +0.3  (agentic in-flight)
 *   - tool_result with is_error / "error" text   → +0.2  (retry implies more reasoning)
 *
 * Max multiplier ~2.8× (all signals firing). Final budget capped per
 * model by capThinkingBudget.
 */
function applyAdaptiveBudget(body, cfg) {
  const messages = body.messages || body.input || [];
  const messageCount = messages.length;
  const tools = body.tools || [];
  const toolCount = tools.length;

  // Get last user message length
  let lastMsgLength = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      lastMsgLength =
        typeof msg.content === "string"
          ? msg.content.length
          : JSON.stringify(msg.content || "").length;
      break;
    }
  }

  // Content-aware signals: scan last 5 messages for tool_use blocks
  // (Claude shape: content[].type==="tool_use" ; OpenAI shape: msg.tool_calls)
  // and for error-flagged tool_result blocks.
  const recentSlice = messages.slice(-5);
  let hasRecentToolUse = false;
  let hasErrorToolResult = false;
  const ERROR_TEXT_RE = /\b(error|exception|failed|traceback|stderr)\b/i;
  for (const msg of recentSlice) {
    if (!msg || typeof msg !== "object") continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      hasRecentToolUse = true;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") hasRecentToolUse = true;
        if (block.type === "tool_result") {
          if (block.is_error === true) {
            hasErrorToolResult = true;
            continue;
          }
          const content = block.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join(" ")
                : "";
          if (ERROR_TEXT_RE.test(text)) hasErrorToolResult = true;
        }
      }
    }
  }

  // Calculate multiplier
  let multiplier = 1.0;
  if (messageCount > 10) multiplier += 0.5;
  if (toolCount > 3) multiplier += 0.5;
  if (lastMsgLength > 2000) multiplier += 0.3;
  if (hasRecentToolUse) multiplier += 0.3;
  if (hasErrorToolResult) multiplier += 0.2;

  // Resolve effort tier baseline.
  // Priority: body.output_config.effort > cfg.effortLevel > "medium".
  const bodyEffort =
    body.output_config && typeof body.output_config === "object"
      ? (body.output_config as Record<string, unknown>).effort
      : undefined;
  const tier =
    (typeof bodyEffort === "string" && EFFORT_BASELINES[bodyEffort.toLowerCase()] !== undefined
      ? bodyEffort.toLowerCase()
      : null) ||
    (typeof cfg.effortLevel === "string" && EFFORT_BASELINES[cfg.effortLevel] !== undefined
      ? cfg.effortLevel
      : null) ||
    "medium";
  const baseBudget = EFFORT_BASELINES[tier] ?? EFFORT_BASELINES.medium;
  const budget = capThinkingBudget(body.model || "", Math.ceil(baseBudget * multiplier));

  return setCustomBudget(body, budget);
}

/**
 * Check if model name suggests thinking capability
 */
export function hasThinkingCapableModel(body) {
  const model = body.model || "";
  const resolved = getResolvedModelCapabilities(model);
  if (resolved.supportsThinking === true) return true;
  if (resolved.supportsThinking === false) return false;
  return (
    model.includes("claude") ||
    model.includes("o1") ||
    model.includes("o3") ||
    model.includes("o4") ||
    model.includes("gemini") ||
    model.endsWith("-thinking") ||
    model.includes("thinking")
  );
}
