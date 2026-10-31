// omp's one-shot model calls (compaction summary, turn-prefix summary, branch summary,
// and side requests such as titles and recaps) go through pi-agent-core's
// `instrumentedCompleteSimple`, which passes no `convertToLlm` callback. Every
// agent-loop turn (main session and task subagents) passes one as a function.
//
// This is how the bridge tells the two apart: omp wraps the AbortSignal it hands to
// session_before_compact / session_before_tree, so the signal the provider sees is not
// the one marked in the hook, and omp sends no `cacheRetention: "none"` marker either.

/** True when `options` belong to an omp one-shot call rather than an agent-loop turn. */
export function isOmpOneShotCall(options: unknown): boolean {
	return typeof (options as { convertToLlm?: unknown } | null | undefined)?.convertToLlm !== "function";
}
