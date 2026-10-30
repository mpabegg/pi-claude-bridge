/**
 * Recognizes the one-off summary calls (compaction, branch summary) a host
 * sends through the provider. Pi marks them with `cacheRetention: "none"`.
 * A host that does not send that option can instead mark the call's
 * AbortSignal: the same AbortController feeds the host's summary hook and the
 * summarizer, so the mark made in the hook is visible on the provider call.
 */

const hostSummarySignals = new WeakSet<AbortSignal>();

/** Mark `signal` as belonging to a host summary call. */
export function markHostSummarySignal(signal: AbortSignal): void {
	hostSummarySignals.add(signal);
}

/** True for pi's `cacheRetention: "none"` marker or a signal marked by the host. */
export function isHostSummaryCall(options?: { cacheRetention?: string; signal?: AbortSignal }): boolean {
	if (options?.cacheRetention === "none") return true;
	return options?.signal !== undefined && hostSummarySignals.has(options.signal);
}
