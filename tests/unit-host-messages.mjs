#!/usr/bin/env node
// Hosts such as Oh My Pi put `role: "developer"` messages (@file mentions, custom
// and hook messages) into the provider context. normalizeHostMessages maps them to
// user messages so the digest and conversion code, which only accepts user,
// assistant and toolResult, can read them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHostMessages } from "../src/host-messages.js";
import { digestMessage } from "../src/message-digests.js";
import { convertPiMessages } from "../src/convert.js";

const FILE = '<file path="a.ts">x</file>';
const developer = () => ({ role: "developer", content: [{ type: "text", text: FILE }], timestamp: 1 });
const user = () => ({ role: "user", content: [{ type: "text", text: FILE }], timestamp: 1 });

describe("normalizeHostMessages", () => {
	it("maps developer text to a user message with the same content and timestamp", () => {
		const input = [developer()];
		const [out] = normalizeHostMessages(input);
		assert.deepEqual(out, user());
		assert.equal(input[0].role, "developer", "the host's message is not mutated");
	});

	it("keeps the identity of messages that are not developer messages", () => {
		const first = { role: "user", content: "hi", timestamp: 0 };
		const reply = { role: "assistant", content: [], timestamp: 2 };
		const out = normalizeHostMessages([first, developer(), reply]);
		assert.equal(out[0], first);
		assert.equal(out[2], reply);
		assert.equal(out[1].role, "user");
	});

	it("returns the same array when no developer message is present", () => {
		const input = [{ role: "user", content: "hi", timestamp: 0 }, { role: "assistant", content: [], timestamp: 1 }];
		const out = normalizeHostMessages(input);
		assert.equal(out, input);
	});

	it("developer digests are stable across normalizations", () => {
		const a = digestMessage(normalizeHostMessages([developer()])[0]);
		const b = digestMessage(normalizeHostMessages([developer()])[0]);
		assert.match(a, /^[0-9a-f]{64}$/);
		assert.equal(a, b);
		assert.equal(a, digestMessage(user()));
	});

	it("convertPiMessages emits a Claude user text block for a normalized developer message", () => {
		const { anthropicMessages } = convertPiMessages(normalizeHostMessages([developer()]));
		assert.equal(anthropicMessages.length, 1);
		assert.equal(anthropicMessages[0].role, "user");
		const content = anthropicMessages[0].content;
		const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
		assert.deepEqual(blocks.map((b) => b.type), ["text"]);
		assert.equal(blocks[0].text, FILE);
	});
});
