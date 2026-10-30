// Claude subscription quota for omp's /usage and statusline. Each fetch starts
// one short-lived Claude Code process through the Agent SDK, sends no prompt (so
// no model turn), asks for the /usage data via the SDK's experimental get_usage
// control request, and closes the process. Only the percent windows are
// reported — session cost and extra-usage spend are dropped. omp's AuthStorage
// owns caching and refresh cadence; nothing is cached here.
//
// The 5h/7d rows are always present: a window without data is an explicit
// `unknown` row (no fractions), never 0% and never an empty report — omp's
// /usage dashboard renders `limits: []` as "unlimited".

import type { SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PROVIDER_ID } from "../../convert.js";

// Structural subset of oh-my-pi's pi-ai usage types (usage.ts, omp 18.14).
// omp is not a dependency of this package, so this is the contract the bridge
// checks against.
export interface UsageLimit {
  id: string;
  label: string;
  scope: {
    provider: string;
    windowId: string;
    tier?: string;
    shared?: boolean;
  };
  window: {
    id: string;
    label: string;
    durationMs: number;
    /** Epoch ms. */
    resetsAt?: number;
  };
  /** Percent points and fractions; all absent on an `unknown` row. */
  amount: {
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit: "percent";
  };
  status: "ok" | "warning" | "exhausted" | "unknown";
}

export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  /** Provider-wide notes; set when no window has data, saying why. */
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface UsageFetchParams {
  provider: string;
  signal?: AbortSignal;
}

export interface UsageProvider {
  id: typeof PROVIDER_ID;
  /** omp 18.14 passes a second context argument; the bridge needs nothing from it. */
  fetchUsage(params: UsageFetchParams, ctx?: unknown): Promise<UsageReport | null>;
}

export interface UsageDeps {
  query: typeof query;
  pathToClaudeCodeExecutable?: string;
}

/** Upper bound when the caller passes no signal; omp's own default is 10s. */
const USAGE_TIMEOUT_MS = 15_000;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

interface WindowSpec {
  windowId: "5h" | "7d";
  windowLabel: string;
  durationMs: number;
  label: string;
  tier?: string;
}

const FIVE_HOUR: Omit<WindowSpec, "label" | "tier"> = {
  windowId: "5h",
  windowLabel: "5 Hour",
  durationMs: 5 * HOUR_MS,
};
const SEVEN_DAY: Omit<WindowSpec, "label" | "tier"> = {
  windowId: "7d",
  windowLabel: "7 Day",
  durationMs: WEEK_MS,
};

// get_usage can silently return old CLI-cached data after an upstream failure.
// Missing resets are distinct from malformed ones; the latter must not erase
// our only clue to freshness and leave a falsely current percentage.
const bucketFields = {
  utilization: z.number().nullish().catch(null),
  resets_at: z.string().nullish().catch("invalid"),
};
const Bucket = z.object(bucketFields).nullish().catch(null);
type Bucket = z.infer<typeof Bucket>;
const UsageResponse = z.object({
  rate_limits_available: z.boolean().catch(false),
  rate_limits: z
    .object({
      five_hour: Bucket,
      seven_day: Bucket,
      seven_day_opus: Bucket,
      seven_day_sonnet: Bucket,
      seven_day_oauth_apps: Bucket,
      model_scoped: z
        .array(
          z
            .object({ display_name: z.string(), ...bucketFields })
            .nullable()
            .catch(null),
        )
        .nullish()
        .catch(null),
    })
    .nullish()
    .catch(null),
});

/** One bucket → percent limit. Missing utilization, malformed reset, or a
 *  window already due is unknown: cached old data proves neither renewed
 *  allowance nor the current window's utilization. */
function buildLimit(bucket: Bucket, spec: WindowSpec, now: number): UsageLimit {
  const hasReset = bucket?.resets_at != null;
  const resetsAt = hasReset ? Date.parse(bucket.resets_at) : NaN;
  const currentReset = Number.isFinite(resetsAt) && resetsAt > now;
  const row = {
    id: `${PROVIDER_ID}:${spec.windowId}${spec.tier ? `:${spec.tier}` : ""}`,
    label: spec.label,
    // Tiered rows are per-model counters; only the umbrella windows are shared.
    scope: {
      provider: PROVIDER_ID,
      windowId: spec.windowId,
      ...(spec.tier ? { tier: spec.tier } : { shared: true }),
    },
    window: {
      id: spec.windowId,
      label: spec.windowLabel,
      durationMs: spec.durationMs,
      ...(currentReset ? { resetsAt } : {}),
    },
  };
  if (bucket?.utilization == null || (hasReset && !currentReset)) {
    return { ...row, amount: { unit: "percent" }, status: "unknown" };
  }
  const used = Math.min(Math.max(bucket.utilization, 0), 100);
  const usedFraction = used / 100;
  return {
    ...row,
    amount: {
      used,
      limit: 100,
      remaining: 100 - used,
      usedFraction,
      remainingFraction: (100 - used) / 100,
      unit: "percent",
    },
    status:
      usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
  };
}

/** get_usage response → omp report. Main windows always present (unknown when
 *  missing); model/app windows only when they carry data. */
function normalizeUsage(response: unknown, now: number): UsageReport {
  const parsed = UsageResponse.safeParse(response);
  const rateLimits =
    parsed.success && parsed.data.rate_limits_available
      ? parsed.data.rate_limits
      : null;

  const limits = [
    buildLimit(rateLimits?.five_hour, { ...FIVE_HOUR, label: "Claude 5 Hour" }, now),
    buildLimit(rateLimits?.seven_day, { ...SEVEN_DAY, label: "Claude 7 Day" }, now),
  ];

  const weekly: Array<[Bucket, string]> = rateLimits
    ? [
        [rateLimits.seven_day_opus, "Opus"],
        [rateLimits.seven_day_sonnet, "Sonnet"],
        ...(rateLimits.model_scoped ?? [])
          .filter((entry) => entry !== null)
          .map((entry): [Bucket, string] => [entry, entry.display_name.trim()]),
        [rateLimits.seven_day_oauth_apps, "OAuth Apps"],
      ]
    : [];
  const tiers = new Set<string>();
  for (const [bucket, name] of weekly) {
    const tier = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!tier || tiers.has(tier) || bucket?.utilization == null) continue;
    tiers.add(tier);
    limits.push(
      buildLimit(bucket, { ...SEVEN_DAY, label: `Claude 7 Day (${name})`, tier }, now),
    );
  }

  const reason = !parsed.success
    ? "Claude Code returned an unreadable usage response."
    : !parsed.data.rate_limits_available
      ? "Claude Code reports no plan limits for this login (API key, Bedrock/Vertex, or a login without the profile scope)."
      : !rateLimits
        ? "Claude Code returned no plan usage data."
        : "Claude Code returned no readable, unexpired usage windows.";
  const noData = limits.every((limit) => limit.status === "unknown");
  return {
    provider: PROVIDER_ID,
    // Query/check time, not an upstream data timestamp: the CLI provides none.
    fetchedAt: now,
    limits,
    ...(noData ? { notes: [reason] } : {}),
    metadata: { source: "claude-agent-sdk get_usage" },
  };
}

/** Run get_usage in a fresh, prompt-less Claude Code process. The process is
 *  closed on every path; abort/timeout rejects with the signal's reason. */
async function requestUsage(
  deps: UsageDeps,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let release!: () => void;
  const idle = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await idle;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  };
  // index.ts sets this process-wide; with it the CLI skips the plan usage
  // fetch and get_usage answers `rate_limits: null`.
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  const sdkQuery = deps.query({
    prompt: noPrompt(),
    options: {
      cwd: process.cwd(),
      env,
      tools: [],
      settingSources: ["user", "project"],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
      ...(deps.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
        : {}),
    },
  });
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      sdkQuery.close();
    } catch {}
    release();
  }
}

export function createUsageProvider(
  deps: UsageDeps,
  timeoutMs = USAGE_TIMEOUT_MS,
): UsageProvider {
  return {
    id: PROVIDER_ID,
    async fetchUsage(params, _ctx) {
      if (params.provider !== PROVIDER_ID) return null;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = params.signal
        ? AbortSignal.any([params.signal, timeout])
        : timeout;
      return normalizeUsage(await requestUsage(deps, signal), Date.now());
    },
  };
}
