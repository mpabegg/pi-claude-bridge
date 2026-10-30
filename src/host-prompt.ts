import type { PromptCaptureInput } from "./prompt-capture.js";

// A seam for hosts that run the bridge without pi's systemPromptOptions.
//
// pi hands before_agent_start the options it rendered the prompt from, and the
// bridge stashes their portable parts (context files, skills, custom and appended
// text, custom sections) against the prompt. A host that only delivers the rendered
// prompt, possibly as an array of parts (Oh My Pi, issue #232), leaves nothing to
// stash. A host adapter fills the gap by registering a resolver on the extension API
// object it activated the bridge with.

/** The options a capture is recorded from: pi's `systemPromptOptions`, or what a
 *  host resolver recovers in their place. */
export type PromptRecordOptions = {
	customPrompt?: string;
	appendSystemPrompt?: string;
	contextFiles?: { path: string; content: string }[];
	skills?: PromptCaptureInput["skills"];
	sections?: Record<string, string>;
	selectedTools?: string[];
};

export type HostPromptResolver = (
	event: { systemPrompt: string | readonly string[] },
	ctx: unknown,
) => PromptRecordOptions | undefined;

// Keyed by the API object, so each activation sees only its own host's resolver and
// a discarded activation's resolver goes with it.
const resolvers = new WeakMap<object, HostPromptResolver>();

/** Register `resolver` for the bridge activated with `api`. Returns an unregister
 *  function, which leaves a later registration in place. */
export function registerHostPromptParts(api: object, resolver: HostPromptResolver): () => void {
	resolvers.set(api, resolver);
	return () => {
		if (resolvers.get(api) === resolver) resolvers.delete(api);
	};
}

/** The registered resolver's parts for this prompt. A resolver that throws reports
 *  through `error`: a host-shape mismatch should fail the turn with a diagnostic at
 *  lookup, not take down the event handler. */
export function resolveHostPromptParts(
	api: object,
	event: { systemPrompt: string | readonly string[] },
	ctx: unknown,
): { options?: PromptRecordOptions; error?: string } {
	const resolver = resolvers.get(api);
	if (!resolver) return {};
	try {
		const options = resolver(event, ctx);
		return options ? { options } : {};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** The capture key for a system prompt. A host may deliver the prompt as parts; the
 *  registry is keyed by strings, so join them the way they render. */
export function promptKey(systemPrompt: string | readonly string[]): string {
	return typeof systemPrompt === "string" ? systemPrompt : systemPrompt.join("\n\n");
}

/** Appended to an unresolved-capture failure when the host supplied no parts. */
export function describeMissingPromptParts(resolverError?: string): string {
	return "The host's before_agent_start carried no systemPromptOptions and no host prompt-parts resolver supplied them"
		+ (resolverError ? ` (the resolver threw: ${resolverError})` : "")
		+ ", so the bridge had no context files, skills or custom instructions to record for this prompt.";
}
