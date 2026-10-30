import { afterEach, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { default as activate } from "../src/index.js";

const activeStreamKey = Symbol.for("claude-bridge:activeStreamSimple");
beforeEach(() => { delete globalThis[activeStreamKey]; });
afterEach(() => { delete globalThis[activeStreamKey]; });

function checkLaterInstance(modelRegistry, expectedCount) {
	// Keep every handler: the later activation adds both the ordinary
	// session_start handler and the deferred provider-registration handler.
	const handlers = new Map();
	const registrations = [];
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (...args) => registrations.push(args),
		registerTool: () => {},
	};
	activate(pi);
	assert.equal(registrations.length, 1);
	const firstHandlerCount = handlers.get("session_start").length;
	activate(pi);
	assert.equal(registrations.length, 1, "later activation defers registration");
	const laterHandlers = handlers.get("session_start").slice(firstHandlerCount);
	assert.equal(laterHandlers.length, 2);
	const ctx = {
		modelRegistry,
		ui: {},
		mode: "tui",
		cwd: "/x",
		sessionManager: { getSessionId: () => "s" },
	};
	for (const handler of laterHandlers) handler({}, ctx);
	assert.equal(registrations.length, expectedCount);
	assert.ok(registrations.every(([id]) => id === "claude-bridge"));
}

it("later instance skips registration when hasProvider is true", () => {
	checkLaterInstance({ hasProvider: () => true }, 1);
});

it("later instance registers when hasProvider is false", () => {
	checkLaterInstance({ hasProvider: () => false }, 2);
});

it("pi registry with getProvider keeps current behaviour", () => {
	checkLaterInstance({ getProvider: () => ({}) }, 1);
});

it("pi registry registers when getProvider returns undefined", () => {
	checkLaterInstance({ getProvider: () => undefined }, 2);
});

it("getProvider takes precedence over hasProvider", () => {
	checkLaterInstance({
		getProvider: () => undefined,
		hasProvider: () => { assert.fail("hasProvider must not override getProvider"); },
	}, 2);
});

it("later instance registers when neither lookup is available", () => {
	checkLaterInstance({}, 2);
});
