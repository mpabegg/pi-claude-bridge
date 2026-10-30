import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOmpEntry } from "../src/hosts/omp/entry.js";
import { extractOmpPromptParts } from "../src/hosts/omp/prompt-parts.js";
import { resolveHostPromptParts } from "../src/host-prompt.js";
import { isHostSummaryCall } from "../src/host-summary.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/omp-18.14/system-prompt.json", import.meta.url), "utf8"),
).systemPrompt;

/** An omp-like extension API: any number of handlers per event, like omp's `pi.on`.
 *  (tests/lib/mock-pi.mjs keeps one handler per event, so it cannot stand in here.) */
function fakePi() {
	const handlers = new Map();
	const providers = [];
	const tools = [];
	return {
		handlers,
		providers,
		tools,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerProvider(name, config) {
			providers.push({ name, config });
		},
		registerTool(tool) {
			tools.push(tool);
		},
		emit(event, payload, ctx = fakeCtx()) {
			for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload }, ctx);
		},
	};
}

/** A context from a host that passes the omp capability probe. */
function fakeCtx(overrides = {}) {
	const notices = [];
	return {
		notices,
		ui: { notify: (message, type) => notices.push({ message, type }) },
		getAsyncJobSnapshot: () => ({}),
		...overrides,
	};
}

const usageProvider = { id: "claude-bridge", fetchUsage: async () => null };
const deps = { usage: () => usageProvider, extract: extractOmpPromptParts };

/** Activate the entry with an inner extension that records every lifecycle call it gets. */
function activateWithSpies(pi, register = () => {}) {
	const calls = [];
	let wrapped;
	createOmpEntry((api) => {
		wrapped = api;
		api.on("session_start", (event) => calls.push(["start", event]));
		api.on("session_tree", (event) => calls.push(["tree", event]));
		register(api, calls);
	}, deps)(pi);
	return { calls, wrapped };
}

describe("omp entry", () => {
	it("adds the usage provider to the claude-bridge registration only", () => {
		const pi = fakePi();
		activateWithSpies(pi, (api) => {
			api.registerProvider("claude-bridge", { api: "claude-bridge", models: [] });
			api.registerProvider("other", { api: "other", models: [] });
		});
		assert.equal(pi.providers.length, 2);
		const [bridge, other] = pi.providers;
		assert.equal(bridge.name, "claude-bridge");
		assert.equal(bridge.config.usage, usageProvider);
		assert.equal(bridge.config.api, "claude-bridge");
		assert.equal(other.name, "other");
		assert.equal("usage" in other.config, false);
	});

	it("session_switch resume reaches inner session_start handlers with reason resume", () => {
		const pi = fakePi();
		const { calls } = activateWithSpies(pi);
		pi.emit("session_switch", { reason: "resume" });
		assert.deepEqual(calls, [["start", { type: "session_start", reason: "resume" }]]);
	});

	it("session_branch branch calls inner start with fork and inner tree handlers", () => {
		const pi = fakePi();
		const { calls } = activateWithSpies(pi);
		pi.emit("session_branch", { reason: "branch" });
		assert.deepEqual(calls, [
			["start", { type: "session_start", reason: "fork" }],
			["tree", { type: "session_tree" }],
		]);
	});

	it("session_branch btw calls neither", () => {
		const pi = fakePi();
		const { calls } = activateWithSpies(pi);
		pi.emit("session_branch", { reason: "btw" });
		assert.deepEqual(calls, []);
	});

	it("session_before_compact marks the signal as a summary call", () => {
		const pi = fakePi();
		activateWithSpies(pi);
		const { signal } = new AbortController();
		assert.equal(isHostSummaryCall({ signal }), false);
		pi.emit("session_before_compact", { signal });
		assert.equal(isHostSummaryCall({ signal }), true);
	});

	it("session_before_tree marks the signal as a summary call", () => {
		const pi = fakePi();
		activateWithSpies(pi);
		const { signal } = new AbortController();
		pi.emit("session_before_tree", { signal });
		assert.equal(isHostSummaryCall({ signal }), true);
	});

	it("registers a prompt-parts resolver on the wrapped api", () => {
		const pi = fakePi();
		const { wrapped } = activateWithSpies(pi);
		const resolved = resolveHostPromptParts(wrapped, { systemPrompt: fixture }, {});
		assert.equal(resolved.error, undefined);
		assert.ok(resolved.options.sections["omp-project-context"].includes("FIXTURE-AGENTS-RULE"));
		// The resolver is keyed by the wrapped object, not the host's.
		assert.deepEqual(resolveHostPromptParts(pi, { systemPrompt: fixture }, {}), {});
	});

	it("keeps multiple inner handlers per event", () => {
		const pi = fakePi();
		const { calls } = activateWithSpies(pi, (api, calls) => {
			api.on("session_start", (event) => calls.push(["start2", event]));
			api.on("session_tree", (event) => calls.push(["tree2", event]));
		});
		pi.emit("session_switch", { reason: "new" });
		pi.emit("session_branch", { reason: "fork" });
		assert.deepEqual(calls, [
			["start", { type: "session_start", reason: "new" }],
			["start2", { type: "session_start", reason: "new" }],
			["start", { type: "session_start", reason: "fork" }],
			["start2", { type: "session_start", reason: "fork" }],
			["tree", { type: "session_tree" }],
			["tree2", { type: "session_tree" }],
		]);
		// Inner handlers still reach the host for its own session_start / session_tree.
		const hostStart = pi.handlers.get("session_start").length;
		assert.ok(hostStart >= 2, `expected the inner session_start handlers on the host, got ${hostStart}`);
		assert.equal(pi.handlers.get("session_tree").length, 2);
	});

	it("forwards other members of the host api, through one stable wrapped object", () => {
		const pi = fakePi();
		const tool = { name: "T" };
		const { wrapped } = activateWithSpies(pi, (api) => api.registerTool(tool));
		assert.deepEqual(pi.tools, [tool]);
		assert.equal(wrapped.handlers, pi.handlers);
		assert.equal(wrapped.registerTool, wrapped.registerTool);
		assert.notEqual(wrapped, pi);
	});

	it("warns once on session_start when the host lacks the omp capability probe", () => {
		const pi = fakePi();
		activateWithSpies(pi);
		const ctx = fakeCtx({ getAsyncJobSnapshot: undefined });
		pi.emit("session_start", {}, ctx);
		pi.emit("session_start", {}, ctx);
		assert.equal(ctx.notices.length, 1);
		assert.equal(ctx.notices[0].type, "warning");
		assert.match(ctx.notices[0].message, /claude-bridge/);

		const okPi = fakePi();
		activateWithSpies(okPi);
		const okCtx = fakeCtx();
		okPi.emit("session_start", {}, okCtx);
		assert.deepEqual(okCtx.notices, []);
	});
});
