#!/usr/bin/env node
// Unit tests for recognizing a host's summary call (host-summary.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isHostSummaryCall, markHostSummarySignal } from "../src/host-summary.js";

describe("isHostSummaryCall", () => {
	it("cacheRetention none is a summary call", () => {
		assert.equal(isHostSummaryCall({ cacheRetention: "none" }), true);
	});

	it("a marked signal is a summary call", () => {
		const signal = new AbortController().signal;
		markHostSummarySignal(signal);
		assert.equal(isHostSummaryCall({ signal }), true);
	});

	it("an unmarked signal is not", () => {
		const signal = new AbortController().signal;
		assert.equal(isHostSummaryCall({ signal }), false);
		assert.equal(isHostSummaryCall({ cacheRetention: "short", signal }), false);
	});

	it("no options is not", () => {
		assert.equal(isHostSummaryCall(), false);
		assert.equal(isHostSummaryCall({}), false);
	});
});
