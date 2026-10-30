/**
 * `provider.isolateAnthropicEnv` keeps inherited Anthropic auth variables away from
 * the Claude Code children the bridge spawns, so a shell-exported API key or gateway
 * URL cannot override the subscription login (TODO item 7, #107). Off by default:
 * an unset option must leave the child env exactly as it was.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const ISOLATED = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));

function setInherited() {
	process.env.ANTHROPIC_API_KEY = "sk-test-key";
	process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
	process.env.ANTHROPIC_BASE_URL = "https://gateway.test";
}

afterEach(() => {
	for (const k of ISOLATED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("provider.isolateAnthropicEnv", () => {
	it("isolateAnthropicEnv false keeps inherited Anthropic env", () => {
		setInherited();
		for (const provider of [undefined, {}, { isolateAnthropicEnv: false }]) {
			const env = __test.buildCcChildEnv(provider);
			assert.equal(env.ANTHROPIC_API_KEY, "sk-test-key");
			assert.equal(env.ANTHROPIC_AUTH_TOKEN, "test-token");
			assert.equal(env.ANTHROPIC_BASE_URL, "https://gateway.test");
			assert.deepEqual(env, { ...process.env, ...__test.CC_CHILD_ENV });
		}
	});

	it("isolateAnthropicEnv true drops ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL from the child env", () => {
		setInherited();
		process.env.ANTHROPIC_MODEL = "kept";
		try {
			const env = __test.buildCcChildEnv({ isolateAnthropicEnv: true });
			for (const k of ISOLATED) assert.equal(k in env, false, `${k} must not reach the child`);
			assert.equal(env.ANTHROPIC_MODEL, "kept", "only the three auth variables are dropped");
			assert.equal(env.DISABLE_AUTO_COMPACT, "1", "the bridge's own child env still applies");
		} finally {
			delete process.env.ANTHROPIC_MODEL;
		}
	});

	it("isolation never mutates process.env", () => {
		setInherited();
		const before = { ...process.env };
		__test.buildCcChildEnv({ isolateAnthropicEnv: true });
		assert.deepEqual({ ...process.env }, before);
		assert.equal(process.env.ANTHROPIC_API_KEY, "sk-test-key");
	});
});
