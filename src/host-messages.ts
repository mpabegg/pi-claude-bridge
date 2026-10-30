/**
 * Hosts other than pi (Oh My Pi) put `role: "developer"` messages into the provider
 * context for `@file` mentions and custom/hook messages. The bridge's digest and
 * conversion code only knows user, assistant and toolResult, so map `developer` to
 * `user` once at the provider entry point. pi never sends `developer`, so there this
 * returns the input array unchanged.
 *
 * Mapping to `user` loses the developer role's distinct instruction priority: Claude
 * Code receives these messages as ordinary user context.
 */
export function normalizeHostMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	if (!messages.some((message) => message.role === "developer")) return messages as T[];
	return messages.map((message) => (message.role === "developer" ? { ...message, role: "user" } : message));
}
