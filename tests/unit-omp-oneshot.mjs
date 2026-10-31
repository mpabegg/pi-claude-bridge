import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOmpEntry } from "../src/hosts/omp/entry.js";
import { isOmpOneShotCall } from "../src/hosts/omp/oneshot.js";
import { extractOmpPromptParts } from "../src/hosts/omp/prompt-parts.js";
import { isHostSummaryCall } from "../src/host-summary.js";

const deps = { usage: () => ({ id: "claude-bridge", fetchUsage: async () => null }), extract: extractOmpPromptParts };

function fakePi() {
	const providers = [];
	return {
		providers,
		on() {},
		registerProvider(name, config) {
			providers.push({ name, config });
		},
	};
}

/** Register a provider whose streamSimple records the options it receives. */
function registerRecording(name) {
	const pi = fakePi();
	const seen = [];
	createOmpEntry((api) => {
		api.registerProvider(name, {
			api: name,
			models: [],
			streamSimple: (_model, _context, options) => {
				seen.push(options);
				return "stream";
			},
		});
	}, deps)(pi);
	return { streamSimple: pi.providers[0].config.streamSimple, seen };
}

describe("isOmpOneShotCall", () => {
	it("is true without convertToLlm and false with it", () => {
		assert.equal(isOmpOneShotCall({ signal: undefined }), true);
		assert.equal(isOmpOneShotCall({ convertToLlm: () => [] }), false);
	});

	it("is true for undefined options and for a non-function convertToLlm", () => {
		assert.equal(isOmpOneShotCall(undefined), true);
		assert.equal(isOmpOneShotCall(null), true);
		assert.equal(isOmpOneShotCall({ convertToLlm: "nope" }), true);
	});
});

describe("omp claude-bridge streamSimple", () => {
	it("passes cacheRetention none for one-shot calls and keeps the signal", () => {
		const { streamSimple, seen } = registerRecording("claude-bridge");
		const { signal } = new AbortController();
		const result = streamSimple({}, {}, { signal, cacheRetention: "short" });
		assert.equal(result, "stream");
		assert.equal(seen[0].cacheRetention, "none");
		assert.equal(seen[0].signal, signal);
		assert.equal(isHostSummaryCall(seen[0]), true);
	});

	it("handles undefined options", () => {
		const { streamSimple, seen } = registerRecording("claude-bridge");
		streamSimple({}, {});
		assert.equal(seen[0].cacheRetention, "none");
	});

	it("passes agent-loop calls through unchanged", () => {
		const { streamSimple, seen } = registerRecording("claude-bridge");
		const options = { convertToLlm: () => [], cacheRetention: "short" };
		streamSimple({}, {}, options);
		assert.deepEqual(seen[0], options);
		assert.equal(seen[0].cacheRetention, "short");
	});

	it("does not wrap other providers", () => {
		const pi = fakePi();
		const original = () => {};
		createOmpEntry((api) => api.registerProvider("other", { api: "other", streamSimple: original }), deps)(pi);
		assert.equal(pi.providers[0].config.streamSimple, original);
	});

	it("registers fine when the provider has no streamSimple", () => {
		const pi = fakePi();
		createOmpEntry((api) => api.registerProvider("claude-bridge", { api: "claude-bridge" }), deps)(pi);
		assert.equal(pi.providers[0].config.streamSimple, undefined);
	});
});
