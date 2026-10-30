#!/usr/bin/env node

/**
 * Host prompt-parts seam (issue #232).
 *
 * A host whose before_agent_start carries no systemPromptOptions, and whose prompts
 * arrive as string arrays (Oh My Pi), still has to key and fill captures. A host
 * adapter registers a resolver that recovers the portable parts; every capture key,
 * at record and at lookup, goes through promptKey so an array prompt never reaches
 * the string-only registry (`key.charCodeAt is not a function`).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider failure path writes a diag entry to pi's agent dir: keep it off the real one.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-host-prompt-"));
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const {
	describeMissingPromptParts,
	promptKey,
	registerHostPromptParts,
	resolveHostPromptParts,
} = await import("../src/host-prompt.js");

// Only the first activation in a process registers the provider; later ones share it.
let provider;

// A query double that counts launches: reaching it means the capture resolved.
let queries = 0;
beforeEach(() => {
	queries = 0;
	__test.setQuery(() => { queries++; throw new Error("stop after capture resolution"); });
});
afterEach(() => __test.setQuery(null));

const turn = (systemPrompt) => provider.streamSimple(
	provider.models[0],
	{ systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
	{ sessionId: "host-prompt-session" },
);

/** Activate against an inline fake API and return it with its handlers. */
function activateHost() {
	const handlers = new Map();
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (_name, config) => { provider ??= config; },
		registerTool: () => {},
	};
	activate(api);
	return { api, handlers };
}

describe("promptKey", () => {
	it("promptKey passes strings through and joins arrays with blank lines", () => {
		assert.equal(promptKey("one prompt"), "one prompt");
		assert.equal(promptKey(["A", "B", "C"]), "A\n\nB\n\nC");
		assert.equal(promptKey([]), "");
	});
});

describe("host prompt-parts resolver", () => {
	it("uses the registered resolver when systemPromptOptions is absent", () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, () => ({ sections: { "omp-project-context": "P" } }));
		const prompt = ["resolver A", "resolver B"];
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});

		const capture = __test.promptCaptures.resolve(promptKey(prompt));
		assert.ok(capture, "the array prompt is recorded under its promptKey");
		assert.deepEqual(capture.sections, { "omp-project-context": "P" });
	});

	it("native systemPromptOptions wins over the resolver", () => {
		const { api, handlers } = activateHost();
		let calls = 0;
		registerHostPromptParts(api, () => { calls++; return { sections: { resolver: "R" } }; });
		const prompt = "native options prompt";
		handlers.get("before_agent_start")({
			systemPrompt: prompt,
			systemPromptOptions: { sections: { native: "N" } },
		}, {});

		const capture = __test.promptCaptures.resolve(prompt);
		assert.deepEqual(capture.sections, { native: "N" });
		assert.equal(calls, 0, "the resolver is not consulted when the host supplies options");

		// Nor at the recapture sites: the stash came from the host, not the resolver.
		handlers.get("agent_start")({}, { getSystemPrompt: () => `${prompt} widened` });
		assert.equal(calls, 0);
		assert.deepEqual(__test.promptCaptures.resolve(`${prompt} widened`).sections, { native: "N" });
	});

	it("re-resolves at agent_start with the final prompt", () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, (event) => ({ sections: { derived: promptKey(event.systemPrompt) } }));
		handlers.get("before_agent_start")({ systemPrompt: ["rerun A"] }, {});
		handlers.get("agent_start")({}, { getSystemPrompt: () => ["rerun A", "LATE"] });

		const capture = __test.promptCaptures.resolve(promptKey(["rerun A", "LATE"]));
		assert.ok(capture, "the final prompt is recorded under its promptKey");
		assert.deepEqual(capture.sections, { derived: "rerun A\n\nLATE" });
		assert.equal(capture.source, "agent_start");

		handlers.get("turn_start")({}, { getSystemPrompt: () => ["rerun A", "LATE", "TURN"] });
		assert.deepEqual(
			__test.promptCaptures.resolve(promptKey(["rerun A", "LATE", "TURN"])).sections,
			{ derived: "rerun A\n\nLATE\n\nTURN" },
			"turn_start re-resolves too",
		);
	});

	it("unregister removes the resolver", async () => {
		const { api, handlers } = activateHost();
		const unregister = registerHostPromptParts(api, () => ({ sections: { gone: "G" } }));
		assert.deepEqual(resolveHostPromptParts(api, { systemPrompt: "x" }, {}).options, { sections: { gone: "G" } });
		unregister();
		assert.deepEqual(resolveHostPromptParts(api, { systemPrompt: "x" }, {}), {});

		// With no resolver left, an array prompt has no parts to carry: nothing is
		// recorded, and the turn fails naming the missing systemPromptOptions.
		const prompt = ["unregistered A"];
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});
		assert.equal(__test.promptCaptures.resolve(promptKey(prompt)), undefined);
		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.equal(queries, 0);
	});

	it("resolver errors are surfaced, not thrown", () => {
		const api = {};
		registerHostPromptParts(api, () => { throw new Error("omp shape changed"); });
		const result = resolveHostPromptParts(api, { systemPrompt: ["x"] }, {});
		assert.equal(result.options, undefined);
		assert.match(result.error, /omp shape changed/);
	});

	it("describeMissingPromptParts names systemPromptOptions and the resolver error", () => {
		assert.match(describeMissingPromptParts(), /systemPromptOptions/);
		const withError = describeMissingPromptParts("omp shape changed");
		assert.match(withError, /systemPromptOptions/);
		assert.match(withError, /omp shape changed/);
	});
});

describe("provider lookup of an array prompt", () => {
	it("resolves the capture recorded for the same array prompt", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, () => ({ sections: { "omp-project-context": "P" } }));
		const prompt = ["provider A", "provider B"];
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});

		const result = await turn(prompt).result();
		assert.doesNotMatch(result.errorMessage ?? "", /prompt-capture|charCodeAt/);
		assert.equal(queries, 1, "the capture resolved and the query launched");
	});

	it("names the missing systemPromptOptions when an unknown array prompt fails", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, () => { throw new Error("omp shape changed"); });
		handlers.get("before_agent_start")({ systemPrompt: ["failing A"] }, {});

		const result = await turn(["never recorded"]).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.match(result.errorMessage, /omp shape changed/);
		assert.equal(queries, 0);
	});

	it("fails the prompt a throwing resolver saw, naming its error", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, () => { throw new Error("omp shape changed"); });
		const prompt = ["thrown A", "thrown B"];
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});
		handlers.get("agent_start")({}, { getSystemPrompt: () => prompt });
		handlers.get("turn_start")({}, { getSystemPrompt: () => prompt });
		assert.equal(__test.promptCaptures.resolve(promptKey(prompt)), undefined, "no empty capture is recorded");

		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.match(result.errorMessage, /omp shape changed/);
		assert.equal(queries, 0);
	});

	it("fails an array prompt when no resolver is registered", async () => {
		const { handlers } = activateHost();
		const prompt = ["no resolver A", "no resolver B"];
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});
		handlers.get("agent_start")({}, { getSystemPrompt: () => prompt });
		assert.equal(__test.promptCaptures.resolve(promptKey(prompt)), undefined, "no empty capture is recorded");

		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.doesNotMatch(result.errorMessage, /resolver threw/);
		assert.equal(queries, 0);
	});

	it("does not fall back to the stash when re-resolution comes back empty", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, (event) => (
			promptKey(event.systemPrompt).includes("LATE") ? undefined : { sections: { early: "E" } }
		));
		handlers.get("before_agent_start")({ systemPrompt: ["stale A"] }, {});
		assert.deepEqual(__test.promptCaptures.resolve("stale A").sections, { early: "E" });

		const late = ["stale B", "LATE"];
		handlers.get("agent_start")({}, { getSystemPrompt: () => late });
		assert.equal(__test.promptCaptures.resolve(promptKey(late)), undefined, "the stale parts are not recorded under it");

		const result = await turn(late).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.equal(queries, 0);
	});

	it("clears the missing-parts state when a recapture resolves", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, (event) => (
			promptKey(event.systemPrompt).includes("LATE") ? { sections: { late: "L" } } : undefined
		));
		handlers.get("before_agent_start")({ systemPrompt: ["recovers A"] }, {});
		const late = ["recovers B", "LATE"];
		handlers.get("agent_start")({}, { getSystemPrompt: () => late });
		assert.deepEqual(__test.promptCaptures.resolve(promptKey(late)).sections, { late: "L" });

		// A miss now has some other cause; the hint is not attached to it.
		const result = await turn(["recovers unknown"]).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.doesNotMatch(result.errorMessage, /systemPromptOptions/);
	});

	it("fails an empty array prompt from a host that supplied no parts", async () => {
		const { handlers } = activateHost();
		handlers.get("before_agent_start")({ systemPrompt: [] }, {});

		const result = await turn([]).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /empty system prompt/);
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.equal(queries, 0);
	});

	it("leaves a string prompt with no options and no resolver as it was", async () => {
		const { handlers } = activateHost();
		const prompt = "plain string prompt without options";
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});
		const capture = __test.promptCaptures.resolve(prompt);
		assert.ok(capture, "recorded as before, with no parts to carry");
		assert.deepEqual(capture.contextFiles, []);

		const result = await turn(prompt).result();
		assert.doesNotMatch(result.errorMessage ?? "", /prompt-capture|systemPromptOptions/);
		assert.equal(queries, 1);
	});

	it("fails a string prompt whose registered resolver supplied no parts", async () => {
		const { api, handlers } = activateHost();
		registerHostPromptParts(api, () => undefined);
		const prompt = "string prompt the resolver could not read";
		handlers.get("before_agent_start")({ systemPrompt: prompt }, {});
		assert.equal(__test.promptCaptures.resolve(prompt), undefined);

		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /systemPromptOptions/);
		assert.equal(queries, 0);
	});
});

