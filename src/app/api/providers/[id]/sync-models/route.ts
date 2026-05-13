import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { getSyncedAvailableModelsForConnection } from "@/lib/db/models";
import {
  importManagedModels,
  type ManagedModelImportMode,
} from "@/lib/providerModels/managedModelImport";
import { saveCallLog } from "@/lib/usage/callLogs";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  buildModelSyncInternalHeaders,
  isModelSyncInternalRequest,
} from "@/shared/services/modelSyncScheduler";
import { GET as getProviderModels } from "../models/route";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeModelForComparison(model: unknown) {
  const record = asRecord(model);
  const id = toNonEmptyString(record.id) || "";
  const name = toNonEmptyString(record.name) || id;
  const rawSource = toNonEmptyString(record.source)?.toLowerCase();
  const source =
    rawSource === "api-sync" || rawSource === "auto-sync" || rawSource === "imported"
      ? "imported"
      : rawSource || "manual";
  const apiFormat = toNonEmptyString(record.apiFormat) || "chat-completions";
  const supportedEndpoints = Array.isArray(record.supportedEndpoints)
    ? Array.from(
        new Set(
          record.supportedEndpoints
            .map((endpoint) => toNonEmptyString(endpoint))
            .filter((endpoint): endpoint is string => Boolean(endpoint))
        )
      ).sort()
    : ["chat"];

  return {
    id,
    name,
    source,
    apiFormat,
    supportedEndpoints,
  };
}

function isManagedSyncedModel(model: unknown) {
  const record = asRecord(model);
  const source = toNonEmptyString(record.source)?.toLowerCase();
  return source === "api-sync" || source === "auto-sync" || source === "imported";
}

function getErrorMessageFromPayload(payload: JsonRecord): string | null {
  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  const errorRecord = asRecord(error);
  return toNonEmptyString(errorRecord.message) || toNonEmptyString(payload.message);
}

async function readJsonResponse(response: Response): Promise<{
  data: JsonRecord;
  parseError: string | null;
}> {
  const body = await response.text();
  if (!body.trim()) {
    return {
      data: {},
      parseError: "Empty response body from /models",
    };
  }

  try {
    return {
      data: asRecord(JSON.parse(body)),
      parseError: null,
    };
  } catch {
    return {
      data: {},
      parseError: "Invalid JSON response from /models",
    };
  }
}

function summarizeModelChanges(previousModels: unknown, nextModels: unknown) {
  const previousList = Array.isArray(previousModels) ? previousModels : [];
  const nextList = Array.isArray(nextModels) ? nextModels : [];

  const previousMap = new Map(
    previousList
      .map((model) => normalizeModelForComparison(model))
      .filter((model) => model.id)
      .map((model) => [model.id, JSON.stringify(model)])
  );
  const nextMap = new Map(
    nextList
      .map((model) => normalizeModelForComparison(model))
      .filter((model) => model.id)
      .map((model) => [model.id, JSON.stringify(model)])
  );

  let added = 0;
  let removed = 0;
  let updated = 0;

  for (const [id, nextValue] of nextMap.entries()) {
    const previousValue = previousMap.get(id);
    if (!previousValue) {
      added += 1;
      continue;
    }
    if (previousValue !== nextValue) {
      updated += 1;
    }
  }

  for (const id of previousMap.keys()) {
    if (!nextMap.has(id)) {
      removed += 1;
    }
  }

  return {
    added,
    removed,
    updated,
    total: added + removed + updated,
  };
}

function getModelSyncChannelLabel(connection: unknown) {
  const record = asRecord(connection);
  const providerSpecificData = asRecord(record.providerSpecificData);

  return (
    toNonEmptyString(record.displayName) ||
    toNonEmptyString(record.email) ||
    toNonEmptyString(providerSpecificData.tag) ||
    toNonEmptyString(record.name) ||
    toNonEmptyString(record.provider) ||
    (toNonEmptyString(record.id) ? `connection:${String(record.id).slice(0, 8)}` : null) ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// selfFetchWithRetry — exported for unit testing
// ---------------------------------------------------------------------------

export type SelfFetchWithRetryOptions = {
  /** Injectable fetch implementation; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Maximum number of HTTP attempts before falling back. Default: 5. */
  maxRetries?: number;
  /**
   * Base backoff in ms. Each attempt waits backoffMs * (attempt + 1) before
   * the next try (linear growth: 200 ms, 400 ms, 600 ms, ... at default 200 ms).
   * Default: 200.
   */
  backoffMs?: number;
  /** Connection ID used only for the warning log message. Optional. */
  connectionId?: string;
  /**
   * Called as last-resort fallback after all retries are exhausted.
   * Must return a Response. If omitted, returns a synthetic 503.
   */
  inProcessFallback?: () => Promise<Response>;
};

/**
 * Wraps a single loopback self-fetch URL with linear-backoff retry logic.
 *
 * Motivation: at container boot, ModelSync fires up to 17 concurrent
 * self-fetches against http://127.0.0.1:PORT before the in-process HTTP
 * listener is fully accepting connections. The previous single-attempt contract
 * produced one warning per connection per boot. With retry, the fetch succeeds
 * once the listener is up (usually within the first 1-2 attempts after a short
 * delay) and falls back to the in-process route only if all retries fail.
 *
 * Retry contract:
 * - Network errors (fetch failed, ECONNREFUSED): always retry.
 * - HTTP 5xx: treated as transient — retry.
 * - HTTP 4xx: treated as definitive — skip remaining retries and fall back.
 * - HTTP 2xx: success — return immediately.
 */
export async function selfFetchWithRetry(
  url: string,
  opts: SelfFetchWithRetryOptions = {}
): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  const backoffMs = opts.backoffMs ?? 200;
  const connLabel = opts.connectionId ? opts.connectionId.slice(0, 8) : url.slice(-8);

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await f(url, { method: "GET", cache: "no-store" });
      // Any HTTP response (2xx, 4xx, 5xx) means the server is up — return as-is.
      // We only retry on network-level failures (ECONNREFUSED, "fetch failed")
      // which indicate the loopback listener is not yet accepting connections.
      return res;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxRetries - 1) {
      await new Promise<void>((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }

  // All retries exhausted (or 4xx short-circuit) — fall back to in-process route
  console.warn(
    `[ModelSync] Internal /models self-fetch failed for ${connLabel} after ${maxRetries} attempt(s); falling back to in-process route (last err: ${String(lastErr)})`
  );

  if (opts.inProcessFallback) {
    return opts.inProcessFallback();
  }
  return new Response(JSON.stringify({ error: "self-fetch unavailable" }), { status: 503 });
}

// ---------------------------------------------------------------------------
// fetchProviderModelsForSync — private orchestrator (uses selfFetchWithRetry)
// ---------------------------------------------------------------------------

async function fetchProviderModelsForSync(request: Request, connectionId: string) {
  // Construct a safe localhost URL from the incoming request's origin.
  // The route only accepts authenticated or internal-scheduler requests,
  // and the path is hardcoded — no user-controlled URL components reach fetch.
  const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
  const incomingUrl = new URL(request.url);
  const safeOrigin = SAFE_HOSTS.has(incomingUrl.hostname)
    ? incomingUrl.origin
    : `http://127.0.0.1:${process.env.PORT || "20128"}`;
  const modelsPath = `/api/providers/${encodeURIComponent(connectionId)}/models?refresh=true`;
  const headers = {
    cookie: request.headers.get("cookie") || "",
    ...buildModelSyncInternalHeaders(),
  };

  const targetUrl = new URL(modelsPath, safeOrigin).href;

  // Wrap fetch so it forwards the required headers on every retry attempt.
  const fetchWithHeaders: typeof fetch = (input, init) =>
    fetch(input as string, { ...init, headers });

  return selfFetchWithRetry(targetUrl, {
    fetch: fetchWithHeaders,
    connectionId,
    inProcessFallback: () =>
      getProviderModels(
        new Request(new URL(modelsPath, "http://localhost").href, {
          method: "GET",
          headers,
        }),
        { params: { id: connectionId } }
      ),
  });
}

/**
 * POST /api/providers/[id]/sync-models
 *
 * Fetches the model list from a provider's /models endpoint, stores discovered
 * models in the per-connection available-model cache, and removes matching
 * upstream-discovered rows from the provider's custom model list. Successful
 * syncs only write a call log when the fetched channel or custom model cleanup
 * changes stored model state.
 *
 * Used by:
 * - modelSyncScheduler (auto-sync on interval)
 * - Manual trigger from UI
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  const { id } = await params;
  const mode = (
    new URL(request.url).searchParams.get("mode") === "import" ? "merge" : "sync"
  ) as ManagedModelImportMode;
  let logProvider = "unknown";
  let channelLabel: string | null = null;

  try {
    if (!(await isAuthenticated(request)) && !isModelSyncInternalRequest(request)) {
      return NextResponse.json(
        { error: { message: "Authentication required", type: "invalid_api_key" } },
        { status: 401 }
      );
    }

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    logProvider = toNonEmptyString(connection.provider) || "unknown";
    channelLabel = getModelSyncChannelLabel(connection);
    const previousSyncedAvailableModelsForConnection = await getSyncedAvailableModelsForConnection(
      logProvider,
      id
    );

    const modelsRes = await fetchProviderModelsForSync(request, id);

    const duration = Date.now() - start;
    const { data: modelsData, parseError } = await readJsonResponse(modelsRes);
    const payloadError = getErrorMessageFromPayload(modelsData);

    if (!modelsRes.ok || parseError) {
      const responseStatus = modelsRes.ok ? 502 : modelsRes.status;
      const logError = payloadError || parseError || `HTTP ${modelsRes.status}`;
      const responseError = payloadError || parseError || "Failed to fetch models";
      // Log the failed attempt
      await saveCallLog({
        method: "GET",
        path: `/api/providers/${id}/models`,
        status: modelsRes.status,
        model: "model-sync",
        provider: logProvider,
        sourceFormat: "-",
        connectionId: id,
        duration,
        error: logError,
        requestType: "model-sync",
        ...(parseError
          ? {
              responseBody: {
                upstreamStatus: modelsRes.status,
                parseError,
              },
            }
          : {}),
      });

      return NextResponse.json(
        {
          error: responseError,
          ...(parseError ? { upstreamStatus: modelsRes.status } : {}),
        },
        { status: responseStatus }
      );
    }

    const fetchedModels = modelsData.models || [];
    const {
      previousModels,
      previousSyncedAvailableModels,
      persistedModels,
      importedModels,
      discoveredModels,
      syncedAvailableModels,
      syncedAliases,
      importedChanges,
    } = await importManagedModels({
      providerId: logProvider,
      connectionId: id,
      fetchedModels,
      mode,
      previousSyncedAvailableModels: previousSyncedAvailableModelsForConnection,
    });

    const effectiveAvailableModels =
      discoveredModels.length > 0 ? discoveredModels : syncedAvailableModels;
    const modelChanges = summarizeModelChanges(
      previousSyncedAvailableModels,
      effectiveAvailableModels
    );
    const customModelChanges = summarizeModelChanges(previousModels, persistedModels);
    const syncedModelsCount =
      effectiveAvailableModels.length > 0
        ? effectiveAvailableModels.length
        : persistedModels.filter((model) => isManagedSyncedModel(model)).length;
    const availableModelsCount = new Set(
      [...persistedModels, ...effectiveAvailableModels]
        .map((model) => toNonEmptyString(asRecord(model).id))
        .filter((modelId): modelId is string => Boolean(modelId))
    ).size;
    const importedCount = importedChanges.added;
    const updatedCount = importedChanges.updated;
    const shouldLog = modelChanges.total > 0 || customModelChanges.total > 0;

    if (shouldLog) {
      await saveCallLog({
        method: "GET",
        path: `/api/providers/${id}/models`,
        status: 200,
        model: "model-sync",
        provider: logProvider,
        sourceFormat: "-",
        connectionId: id,
        duration: Date.now() - start,
        requestType: "model-sync",
        responseBody: {
          syncedModels: syncedModelsCount,
          availableModelsCount,
          syncedAliases,
          provider: logProvider,
          channel: channelLabel,
          modelChanges,
          customModelChanges,
          importedCount,
          updatedCount,
          mode,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      provider: logProvider,
      mode,
      syncedModels: syncedModelsCount,
      availableModelsCount,
      syncedAliases,
      modelChanges,
      customModelChanges,
      importedCount,
      updatedCount,
      importedChanges,
      logged: shouldLog,
      models: persistedModels,
      importedModels,
    });
  } catch (error: any) {
    // Log error
    await saveCallLog({
      method: "POST",
      path: `/api/providers/${id}/sync-models`,
      status: 500,
      model: "model-sync",
      provider: logProvider,
      sourceFormat: "-",
      connectionId: id,
      duration: Date.now() - start,
      error: error.message || "Sync failed",
      requestType: "model-sync",
      ...(channelLabel
        ? {
            responseBody: {
              channel: channelLabel,
            },
          }
        : {}),
    }).catch(() => {});

    return NextResponse.json({ error: error.message || "Failed to sync models" }, { status: 500 });
  }
}
