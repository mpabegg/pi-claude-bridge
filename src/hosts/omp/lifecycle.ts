// Oh My Pi reports session changes with events pi does not have. The shared extension
// listens for pi's: `session_start` with a reason (new, resume, fork) to drop
// per-session state, and `session_tree` to force a rebuild after the history was
// rewritten. omp's `session_start` fires once, without a reason; a later switch is
// `session_switch`, and a branch or fork off an earlier entry is `session_branch`.
// This maps each onto the handlers the shared extension registered for pi's events.

export type Handler = (event: any, ctx: any) => unknown;

const SWITCH_REASONS = new Set(["new", "resume", "fork"]);
/** `btw` is not routed: a `/btw` promotion moves to a new session id and appends the
 *  Q/A pair there, so upstream imports that session on its own; nothing to reset. */
const BRANCH_REASONS = new Set(["branch", "fork"]);

/** Call the shared extension's `session_start` / `session_tree` handlers for an omp
 *  `session_switch` / `session_branch` event. A branch moves to a new session id
 *  holding a cut of the old history: pi's fork for the session change, and pi's tree
 *  navigation for the rewritten history, so it gets both. Unknown reasons do nothing. */
export function routeOmpLifecycle(
	event: { type: "session_switch" | "session_branch"; reason: string },
	inner: { start: Handler[]; tree: Handler[] },
	ctx: unknown,
): void {
	if (event.type === "session_switch") {
		if (!SWITCH_REASONS.has(event.reason)) return;
		for (const handler of inner.start) handler({ type: "session_start", reason: event.reason }, ctx);
		return;
	}
	if (!BRANCH_REASONS.has(event.reason)) return;
	for (const handler of inner.start) handler({ type: "session_start", reason: "fork" }, ctx);
	for (const handler of inner.tree) handler({ type: "session_tree" }, ctx);
}
