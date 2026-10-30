import type { PromptRecordOptions } from "../../host-prompt.js";

// Oh My Pi hands extensions its whole harness system prompt as string[]. Only the
// parts that carry the user's project and configuration are portable to Claude Code;
// the rest is omp's own tool, workflow and delivery instructions, which would
// contradict the bridged tool set. Markers are those recorded from omp 18.14
// (tests/fixtures/omp-18.14/README.md), scanned with indexOf rather than a regex so
// the last-closing-tag rule below stays explicit.
//
// Element layout: [0] the rendered template, starting at `§ Role`; any harness
// elements after it (eval prelude, `# Browser Relay`, ...); the project element,
// `<project-context>` then a `<critical>` block then trailing text (`# Memory`,
// user instructions); then anything extensions appended.

const TEMPLATE_HEADING = "§ Role";
const PROJECT_OPEN = "<project-context>";
const PROJECT_CLOSE = "</project-context>";
const CRITICAL_OPEN = "<critical>";
const CRITICAL_CLOSE = "</critical>";

/** The prompt does not have the shape this extractor was written against: omp changed
 *  its template, or the host is not the omp it was recorded from. `missing` is the
 *  marker that was expected. */
export class OmpPromptShapeError extends Error {
	readonly missing: string;
	constructor(missing: string) {
		super(`omp system prompt has an unexpected shape: ${missing} not found`);
		this.name = "OmpPromptShapeError";
		this.missing = missing;
	}
}

/** `open`..`close` inclusive, from the first `open` to the first `close` after it. */
function block(text: string, open: string, close: string): string | undefined {
	const start = text.indexOf(open);
	if (start < 0) return undefined;
	const end = text.indexOf(close, start);
	return end < 0 ? undefined : text.slice(start, end + close.length);
}

/** The first line-start index at or after `from` where a line begins with one of `prefixes`. */
function nextLineStart(text: string, from: number, prefixes: readonly string[]): number {
	let best = -1;
	for (const prefix of prefixes) {
		const at = text.indexOf(`\n${prefix}`, from);
		if (at >= 0 && (best < 0 || at < best)) best = at;
	}
	return best < 0 ? text.length : best;
}

/** The section headed `heading` (a line start), up to the next line beginning with one
 *  of `stops`, or the end of the text. */
function section(text: string, heading: string, stops: readonly string[]): string | undefined {
	const at = text.startsWith(heading) ? 0 : text.indexOf(`\n${heading}`) + 1;
	if (at <= 0 && !text.startsWith(heading)) return undefined;
	return text.slice(at, nextLineStart(text, at + heading.length, stops)).trim();
}

export function extractOmpPromptParts(systemPrompt: readonly string[]): PromptRecordOptions {
	const template = systemPrompt[0];
	if (template === undefined || !template.includes(TEMPLATE_HEADING)) {
		throw new OmpPromptShapeError(TEMPLATE_HEADING);
	}
	let projectIndex = -1;
	for (let i = 1; i < systemPrompt.length; i++) {
		if (systemPrompt[i].includes(PROJECT_OPEN)) {
			projectIndex = i;
			break;
		}
	}
	if (projectIndex < 0) throw new OmpPromptShapeError(PROJECT_OPEN);

	const sections: Record<string, string> = {};

	// From the first opening tag to the LAST closing tag: repo rules may quote the tag.
	const projectElement = systemPrompt[projectIndex];
	const open = projectElement.indexOf(PROJECT_OPEN);
	const close = projectElement.lastIndexOf(PROJECT_CLOSE);
	if (close < open) throw new OmpPromptShapeError(PROJECT_CLOSE);
	const closeEnd = close + PROJECT_CLOSE.length;
	sections["omp-project-context"] = projectElement.slice(open, closeEnd);

	const skills = block(template, "<skills>", "</skills>");
	if (skills) sections["omp-skills"] = skills;

	const rules = [
		block(template, "<generic-rules>", "</generic-rules>"),
		block(template, "<domain-rules>", "</domain-rules>"),
	].filter((b): b is string => b !== undefined);
	if (rules.length > 0) sections["omp-rules"] = rules.join("\n");

	// The personality's own sub-headings are `# ` too, so it runs to the next `§`.
	const personality = section(template, "# Personality", ["§ "]);
	if (personality) sections["omp-personality"] = personality;

	const internalUrls = section(template, "# Internal URLs", ["# ", "§ "]);
	if (internalUrls) sections["omp-internal-urls"] = internalUrls;

	for (let i = projectIndex + 1; i < systemPrompt.length; i++) {
		if (systemPrompt[i]) sections[`omp-extra-${i - projectIndex}`] = systemPrompt[i];
	}

	// What follows the project context: a `<critical>` block (omp's delivery reminders,
	// harness) and then the memory and user-instruction text.
	let trailing = projectElement.slice(closeEnd).trimStart();
	if (trailing.startsWith(CRITICAL_OPEN)) {
		const criticalEnd = trailing.indexOf(CRITICAL_CLOSE);
		trailing = criticalEnd < 0 ? "" : trailing.slice(criticalEnd + CRITICAL_CLOSE.length);
	}
	trailing = trailing.trim();

	return {
		contextFiles: [],
		skills: [],
		sections,
		...(trailing ? { appendSystemPrompt: trailing } : {}),
	};
}
