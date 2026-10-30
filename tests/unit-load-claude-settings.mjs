/**
 * Provider turns load no Claude Code settings unless `provider.loadClaudeSettings`
 * is true (TODO #6, #141): ~/.claude hooks, plugins and output styles would
 * otherwise reach every pi turn. Settings.json is also where Bedrock/Vertex
 * users keep `env` and `apiKeyHelper`, which is what the opt-in is for.
 * The query function is injected, so no Claude Code process starts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, isolatedStreamFn } = mod.__test;
const configFile = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json");

// Config is read at activation, so each case activates a fresh provider.
function activate(provider) {
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(configFile, JSON.stringify({ startupNoticeShown: "2026-01-01", provider }));
	// A second activation registers only once the first has released the slot.
	globalThis[Symbol.for("claude-bridge:activeStreamSimple")] = undefined;
	let registered;
	mod.default({ on: () => {}, registerProvider: (_name, config) => { registered = config; }, registerTool: () => {} });
	return registered;
}

const ev = (event) => ({ type: "stream_event", event });
const reply = [
	ev({ type: "message_start", message: { id: "msg_1", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];

let launches;
beforeEach(() => {
	resetSharedSession();
	launches = [];
	setQuery(({ prompt, options }) => {
		launches.push(options);
		const gen = (async function* () {
			const first = (await prompt[Symbol.asyncIterator]().next()).value;
			const session_id = options.sessionId ?? options.resume;
			yield { type: "system", subtype: "init", session_id };
			yield { ...first, isReplay: true, session_id };
			for (const step of reply) yield step;
			yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => {
	setQuery(null);
	rmSync(configFile, { force: true });
});

async function providerTurn(provider, sessionId) {
	const config = activate(provider);
	const model = config.models[0];
	const out = await config.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { sessionId }).result();
	assert.equal(out.stopReason, "stop", out.errorMessage);
	assert.equal(launches.length, 1);
	return launches[0];
}

describe("provider.loadClaudeSettings", () => {
	it("provider queries load no Claude Code settings by default", async () => {
		const options = await providerTurn({}, "pi-settings-default");
		assert.deepEqual(options.settingSources, []);
	});

	it("loadClaudeSettings false is the same as unset", async () => {
		const options = await providerTurn({ loadClaudeSettings: false }, "pi-settings-false");
		assert.deepEqual(options.settingSources, []);
	});

	it("loadClaudeSettings true keeps Claude Code's default setting sources", async () => {
		const options = await providerTurn({ loadClaudeSettings: true }, "pi-settings-true");
		assert.equal(options.settingSources, undefined);
	});

	it("keeps the CLAUDE.md excludes in both modes", async () => {
		for (const [loadClaudeSettings, sid] of [[false, "pi-excl-off"], [true, "pi-excl-on"]]) {
			launches.length = 0;
			resetSharedSession();
			const options = await providerTurn({ loadClaudeSettings }, sid);
			assert.deepEqual(options.settings.claudeMdExcludes, ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"]);
		}
	});

	it("the isolated summary path is unchanged", async () => {
		activate({ loadClaudeSettings: true });
		const captured = [];
		setQuery(({ options }) => {
			captured.push(options);
			const gen = (async function* () { yield { type: "result", subtype: "success", is_error: false, result: "summary" }; })();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		const model = { id: "claude-sonnet-4-6", name: "m", api: "claude-bridge", provider: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192 };
		const result = await isolatedStreamFn(model, { systemPrompt: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 0 }] }, { cacheRetention: "none" }).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(captured.length, 1);
		assert.deepEqual(captured[0].settingSources, []);
		assert.deepEqual(captured[0].settings, { autoMemoryEnabled: false });
		assert.equal(captured[0].strictMcpConfig, true);
	});
});
