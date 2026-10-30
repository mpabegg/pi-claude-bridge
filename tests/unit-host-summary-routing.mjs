#!/usr/bin/env node
/**
 * The routing site for host summary calls: a call whose signal the host marked with
 * markHostSummarySignal (omp's compaction and branch summary) carries no
 * cacheRetention, yet must take the isolated summary path like pi's
 * cacheRetention:"none" calls. An unmarked signal takes the normal provider path.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { markHostSummarySignal } from "../src/host-summary.js";

const mod = await import("../src/index.js");
const { __test } = mod;

let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const textReply = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "summary" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];

/** A fake query that records its options and answers with one text reply. */
function captureQuery(captured) {
	return ({ options }) => {
		captured.push(options);
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume ?? "cc-summary" };
			yield* textReply;
			yield { type: "result", subtype: "success", is_error: false, result: "summary" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	};
}

const messages = [{ role: "user", content: "Summarize what happened.", timestamp: 0 }];
const summaryContext = { systemPrompt: "Summarize the conversation.", messages };
// The normal path matches a system prompt against a before_agent_start capture; without
// one it has nothing to match, as in the other provider-path unit tests.
const turnContext = { messages };

async function run(context, options) {
	const captured = [];
	__test.setQuery(captureQuery(captured));
	const result = await providerConfig.streamSimple(model, context, options).result();
	assert.equal(result.stopReason, "stop", `turn failed: ${result.errorMessage}`);
	assert.equal(captured.length, 1);
	return captured[0];
}

afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
});

describe("host summary routing in streamSimple", () => {
	it("a host-marked signal without cacheRetention takes the isolated summary path", async () => {
		const signal = new AbortController().signal;
		markHostSummarySignal(signal);
		const options = await run(summaryContext, { signal, sessionId: "pi-summary-routing-marked" });
		assert.equal(options.persistSession, false);
		assert.deepEqual(options.settingSources, []);
		assert.equal(options.maxTurns, 1);
		assert.deepEqual(options.tools, []);
		assert.equal(options.systemPrompt, summaryContext.systemPrompt);
		assert.equal(options.resume, undefined);
	});

	it("an unmarked signal takes the normal provider path", async () => {
		const signal = new AbortController().signal;
		const options = await run(turnContext, { signal, sessionId: "pi-summary-routing-unmarked" });
		// The provider path: a persisted session, Claude Code's default setting sources,
		// streamed partial messages and the claude_code preset prompt.
		assert.equal(options.persistSession, undefined);
		assert.equal(options.settingSources, undefined);
		assert.equal(options.maxTurns, undefined);
		assert.equal(options.includePartialMessages, true);
		assert.equal(options.systemPrompt?.type, "preset");
	});
});
