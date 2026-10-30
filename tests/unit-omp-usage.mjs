import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUsageProvider } from "../src/hosts/omp/usage.js";

const PARAMS = { provider: "claude-bridge" };
const RESET_5H = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
const RESET_7D = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

/** Scripted SDK query: get_usage resolves/rejects via `answer`. Records whether
 *  the process was closed, the child env, and anything the prompt stream produced. */
function fakeSdk(answer) {
	let closed = false;
	let env;
	const prompts = Promise.withResolvers();
	const query = (params) => {
		env = params.options?.env;
		if (typeof params.prompt !== "string") {
			const stream = params.prompt;
			void (async () => {
				const seen = [];
				for await (const message of stream) seen.push(message);
				prompts.resolve(seen);
			})();
		}
		return {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: answer,
			close: () => {
				closed = true;
			},
		};
	};
	return { query, closed: () => closed, prompts: prompts.promise, env: () => env };
}

const providerFor = (fake, timeoutMs) => createUsageProvider({ query: fake.query }, timeoutMs);

const withLimits = (rateLimits) =>
	fakeSdk(async () => ({
		session: { total_cost_usd: 1.5, model_usage: {} },
		subscription_type: "max",
		rate_limits_available: true,
		rate_limits: rateLimits,
		behaviors: null,
	}));

const reportFor = (rateLimits) => providerFor(withLimits(rateLimits)).fetchUsage(PARAMS);
const limitsFor = async (rateLimits) => (await reportFor(rateLimits))?.limits;

describe("usage provider", () => {
	it("main windows become percent rows with epoch-ms resets", async () => {
		const fake = withLimits({
			five_hour: { utilization: 0, resets_at: RESET_5H },
			seven_day: { utilization: 100, resets_at: RESET_7D },
			extra_usage: { is_enabled: true, used_credits: 5, utilization: 50 },
		});
		const report = await providerFor(fake).fetchUsage(PARAMS);

		assert.equal(report?.provider, "claude-bridge");
		assert.deepEqual(report.limits.map((l) => [l.id, l.label, l.scope.windowId]), [
			["claude-bridge:5h", "Claude 5 Hour", "5h"],
			["claude-bridge:7d", "Claude 7 Day", "7d"],
		]);
		const [fiveHour, sevenDay] = report.limits;
		assert.deepEqual(fiveHour.amount, { used: 0, limit: 100, remaining: 100, usedFraction: 0, remainingFraction: 1, unit: "percent" });
		assert.equal(fiveHour.status, "ok");
		assert.equal(fiveHour.window.resetsAt, Date.parse(RESET_5H));
		assert.deepEqual(sevenDay.amount, { used: 100, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "percent" });
		assert.equal(sevenDay.status, "exhausted");
		assert.equal(sevenDay.window.resetsAt, Date.parse(RESET_7D));
		// Session cost and extra-usage spend never become rows.
		assert.ok(!JSON.stringify(report).includes("usd"));
	});

	it("null or missing main utilization is an explicit unknown row, never 0%", async () => {
		const report = await reportFor({
			five_hour: { utilization: null, resets_at: RESET_5H },
			seven_day: { utilization: 42, resets_at: RESET_7D },
		});
		const [fiveHour, sevenDay] = report.limits;
		assert.equal(fiveHour.id, "claude-bridge:5h");
		assert.equal(fiveHour.status, "unknown");
		assert.deepEqual(fiveHour.amount, { unit: "percent" });
		assert.equal(fiveHour.window.resetsAt, Date.parse(RESET_5H));
		assert.equal(sevenDay.amount.usedFraction, 0.42);
		assert.equal(report.notes, undefined);
	});

	it("no usable data yields unknown 5h/7d rows with a reason, never an empty report", async () => {
		const apiKeySession = fakeSdk(async () => ({ rate_limits_available: false, rate_limits: null }));
		const reports = [
			await reportFor({ five_hour: null, seven_day: { resets_at: RESET_7D }, seven_day_opus: null }),
			await reportFor(null),
			await providerFor(apiKeySession).fetchUsage(PARAMS),
			await providerFor(fakeSdk(async () => "garbage")).fetchUsage(PARAMS),
		];
		for (const report of reports) {
			assert.deepEqual(report.limits.map((l) => [l.id, l.status, l.amount.usedFraction]), [
				["claude-bridge:5h", "unknown", undefined],
				["claude-bridge:7d", "unknown", undefined],
			]);
			assert.equal(report.notes.length, 1);
		}
		assert.match(reports[2].notes[0], /no plan limits/);
	});

	it("model and app weekly windows are distinct tiered rows", async () => {
		const limits = await limitsFor({
			five_hour: { utilization: 10, resets_at: RESET_5H },
			seven_day: { utilization: 20, resets_at: RESET_7D },
			seven_day_opus: { utilization: 30, resets_at: RESET_7D },
			seven_day_sonnet: null,
			seven_day_oauth_apps: { utilization: 5, resets_at: RESET_7D },
			model_scoped: [
				{ display_name: "Fable", utilization: 46, resets_at: RESET_7D },
				{ display_name: "Opus", utilization: 99, resets_at: RESET_7D },
				{ utilization: 7 },
				"garbage",
			],
		});
		assert.deepEqual(limits.map((l) => [l.id, l.label, l.scope.tier, l.amount.used]), [
			["claude-bridge:5h", "Claude 5 Hour", undefined, 10],
			["claude-bridge:7d", "Claude 7 Day", undefined, 20],
			["claude-bridge:7d:opus", "Claude 7 Day (Opus)", "opus", 30],
			["claude-bridge:7d:fable", "Claude 7 Day (Fable)", "fable", 46],
			["claude-bridge:7d:oauth-apps", "Claude 7 Day (OAuth Apps)", "oauth-apps", 5],
		]);
		// Only the umbrella windows gate every model.
		assert.deepEqual(limits.filter((l) => l.scope.shared).map((l) => l.id), [
			"claude-bridge:5h",
			"claude-bridge:7d",
		]);
	});

	it("expired or malformed resets never expose old percentages as current", async () => {
		const limits = await limitsFor({
			five_hour: { utilization: 100, resets_at: "not a date" },
			seven_day: { utilization: 80, resets_at: "2020-01-01T00:00:00Z" },
			seven_day_opus: { utilization: "12", resets_at: RESET_7D },
			seven_day_sonnet: { utilization: 25, resets_at: 1790000000 },
			model_scoped: [{ display_name: "Fable", utilization: 90, resets_at: "2020-01-01T00:00:00Z" }],
		});
		assert.deepEqual(limits.map((l) => [l.id, l.status, l.amount, l.window.resetsAt]), [
			["claude-bridge:5h", "unknown", { unit: "percent" }, undefined],
			["claude-bridge:7d", "unknown", { unit: "percent" }, undefined],
			["claude-bridge:7d:sonnet", "unknown", { unit: "percent" }, undefined],
			["claude-bridge:7d:fable", "unknown", { unit: "percent" }, undefined],
		]);
	});

	it("reset exactly at check time is unknown while a future reset remains known", async (t) => {
		const now = Date.parse("2030-01-01T00:00:00Z");
		t.mock.method(Date, "now", () => now);
		const limits = await limitsFor({
			five_hour: { utilization: 90, resets_at: new Date(now).toISOString() },
			seven_day: { utilization: 20, resets_at: new Date(now + 1000).toISOString() },
		});
		assert.deepEqual(limits[0].amount, { unit: "percent" });
		assert.equal(limits[0].status, "unknown");
		assert.equal(limits[0].window.resetsAt, undefined);
		assert.equal(limits[1].amount.usedFraction, 0.2);
		assert.equal(limits[1].window.resetsAt, now + 1000);
	});

	it("absent reset remains distinct from malformed reset, including initial zero", async () => {
		const limits = await limitsFor({
			five_hour: { utilization: 0 },
			seven_day: { utilization: 25, resets_at: null },
		});
		assert.deepEqual(limits.map((l) => [l.status, l.amount.usedFraction, l.window.resetsAt]), [
			["ok", 0, undefined],
			["ok", 0.25, undefined],
		]);
		assert.equal((await limitsFor({ five_hour: { utilization: -3 } }))[0].amount.used, 0);
		assert.equal((await limitsFor({ five_hour: { utilization: 150 } }))[0].amount.used, 100);
	});

	it("sends no prompt and lifts the nonessential-traffic opt-out for the child", async () => {
		const previous = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
		try {
			const fake = withLimits({ five_hour: { utilization: 1 } });
			await providerFor(fake).fetchUsage(PARAMS);
			assert.deepEqual(await fake.prompts, []);
			assert.equal(fake.env()?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
			assert.equal(fake.env()?.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
			assert.equal(fake.closed(), true);
			// The parent's setting is untouched; only the child's env copy changes.
			assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previous;
		}
	});

	describe("inherited Anthropic auth env", () => {
		const NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

		/** Runs `body` with the three variables set in process.env, then restores them. */
		async function withAnthropicEnv(body) {
			const previous = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
			for (const name of NAMES) process.env[name] = `test-${name}`;
			try {
				await body();
			} finally {
				for (const name of NAMES) {
					if (previous[name] === undefined) delete process.env[name];
					else process.env[name] = previous[name];
				}
			}
		}

		it("usage child drops inherited Anthropic auth env when isolateAnthropicEnv is set", async () => {
			await withAnthropicEnv(async () => {
				const fake = withLimits({ five_hour: { utilization: 1 } });
				await createUsageProvider({ query: fake.query, isolateAnthropicEnv: true }).fetchUsage(PARAMS);
				for (const name of NAMES) assert.equal(fake.env()?.[name], undefined, name);
				// Other inherited env and the child's own settings survive.
				assert.equal(fake.env()?.PATH, process.env.PATH);
				assert.equal(fake.env()?.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
				// The parent's env is untouched; only the child's copy changes.
				for (const name of NAMES) assert.equal(process.env[name], `test-${name}`, name);
			});
		});

		it("usage child keeps inherited Anthropic auth env by default", async () => {
			await withAnthropicEnv(async () => {
				const fake = withLimits({ five_hour: { utilization: 1 } });
				await providerFor(fake).fetchUsage(PARAMS);
				for (const name of NAMES) assert.equal(fake.env()?.[name], `test-${name}`, name);
			});
		});
	});

	it("SDK errors reject and still close the process", async () => {
		const fake = fakeSdk(async () => {
			throw new Error("Claude Code process exited with code 1");
		});
		await assert.rejects(providerFor(fake).fetchUsage(PARAMS), /exited with code 1/);
		assert.equal(fake.closed(), true);
	});

	it("caller cancellation and timeout reject and close the process", async () => {
		const hang = () => Promise.withResolvers().promise;

		const cancelled = fakeSdk(hang);
		const controller = new AbortController();
		const pending = providerFor(cancelled).fetchUsage({ ...PARAMS, signal: controller.signal });
		controller.abort(new Error("caller cancelled"));
		await assert.rejects(pending, /caller cancelled/);
		assert.equal(cancelled.closed(), true);

		// AbortSignal.timeout runs on the platform clock (mocked timers don't drive
		// it); 20ms keeps the real bound exercised without a noticeable wait.
		const timedOut = fakeSdk(hang);
		await assert.rejects(providerFor(timedOut, 20).fetchUsage(PARAMS));
		assert.equal(timedOut.closed(), true);
		assert.deepEqual(await timedOut.prompts, []);

		let spawned = false;
		const query = () => {
			spawned = true;
		};
		const preAborted = AbortSignal.abort(new Error("already cancelled"));
		await assert.rejects(
			createUsageProvider({ query }).fetchUsage({ ...PARAMS, signal: preAborted }),
			/already cancelled/,
		);
		assert.equal(spawned, false);
	});
});
