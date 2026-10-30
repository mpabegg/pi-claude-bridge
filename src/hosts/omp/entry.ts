// Oh My Pi entry point. omp loads this module instead of src/index.ts; it activates the
// same shared extension with a wrapped copy of omp's extension API that closes the
// gaps between the two hosts, leaving the shared extension unaware of omp:
//
// - omp asks each provider for its own quota: the claude-bridge registration gains a
//   usage provider.
// - omp's session_switch / session_branch stand in for pi's session_start reasons and
//   session_tree (lifecycle.ts).
// - omp sends no `cacheRetention: "none"` on compaction and branch-summary calls; the
//   summary hooks' abort signals mark them instead (src/host-summary.ts).
// - omp's before_agent_start has no systemPromptOptions; a resolver recovers the
//   portable parts from omp's system prompt (src/host-prompt.ts, prompt-parts.ts).

import { query } from "@anthropic-ai/claude-agent-sdk";
import activateSharedExtension from "../../index.js";
import { loadConfig } from "../../config.js";
import { PROVIDER_ID } from "../../convert.js";
import { registerHostPromptParts } from "../../host-prompt.js";
import { markHostSummarySignal } from "../../host-summary.js";
import { routeOmpLifecycle, type Handler } from "./lifecycle.js";
import { extractOmpPromptParts } from "./prompt-parts.js";
import { createUsageProvider } from "./usage.js";

export interface OmpEntryDeps {
	usage: () => ReturnType<typeof createUsageProvider>;
	extract: typeof extractOmpPromptParts;
}

/** Shown when the host is not the omp this entry was written against. */
const HOST_MISMATCH_NOTICE =
	"claude-bridge: this host does not look like Oh My Pi (its context has no getAsyncJobSnapshot). "
	+ "The omp entry point may misbehave here; under pi, load src/index.ts instead.";

/** An omp extension factory that activates `activate` with the wrapped API. */
export function createOmpEntry(activate: (pi: any) => void, deps: OmpEntryDeps): (pi: any) => void {
	return (pi) => {
		const inner: { start: Handler[]; tree: Handler[] } = { start: [], tree: [] };

		// Every handler still goes to omp, which fires its own session_start once at
		// startup (without a reason) and session_tree after /tree navigation. The
		// recorded copies are what session_switch / session_branch are routed to.
		const on = (event: string, handler: Handler) => {
			if (event === "session_start") inner.start.push(handler);
			else if (event === "session_tree") inner.tree.push(handler);
			pi.on(event, handler);
		};
		const registerProvider = (name: string, config: object) => {
			pi.registerProvider(name, name === PROVIDER_ID ? { ...config, usage: deps.usage() } : config);
		};
		const overrides: Record<PropertyKey, unknown> = { on, registerProvider };

		// One object for the activation's lifetime: the prompt-parts resolver is keyed
		// by it. Everything but the two overrides reads straight through to omp's API,
		// whose methods are bound to it.
		const wrapped = new Proxy(pi, {
			get: (target, prop) => (Object.hasOwn(overrides, prop) ? overrides[prop] : Reflect.get(target, prop, target)),
		});

		pi.on("session_switch", (event: any, ctx: unknown) => routeOmpLifecycle(event, inner, ctx));
		pi.on("session_branch", (event: any, ctx: unknown) => routeOmpLifecycle(event, inner, ctx));
		pi.on("session_before_compact", (event: any) => markHostSummarySignal(event.signal));
		pi.on("session_before_tree", (event: any) => markHostSummarySignal(event.signal));

		let warnedHostMismatch = false;
		pi.on("session_start", (_event: unknown, ctx: any) => {
			if (warnedHostMismatch || typeof ctx?.getAsyncJobSnapshot === "function") return;
			warnedHostMismatch = true;
			ctx?.ui?.notify?.(HOST_MISMATCH_NOTICE, "warning");
		});

		registerHostPromptParts(wrapped, (e) => deps.extract(e.systemPrompt as string[]));
		activate(wrapped);
	};
}

const realDeps: OmpEntryDeps = {
	usage: () =>
		createUsageProvider({
			query,
			pathToClaudeCodeExecutable: loadConfig(process.cwd()).provider?.pathToClaudeCodeExecutable,
		}),
	extract: extractOmpPromptParts,
};

export default createOmpEntry(activateSharedExtension, realDeps);
