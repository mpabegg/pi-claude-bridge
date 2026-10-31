import type { PromptRecordOptions } from "../../host-prompt.js";

// Oh My Pi hands extensions its whole harness system prompt as string[]. Only the
// parts that carry the user's project and configuration are portable to Claude Code;
// the rest is omp's own tool, workflow and delivery instructions, which would
// contradict the bridged tool set. Markers are those recorded from omp 18.14
// (tests/fixtures/omp-18.14/README.md), scanned with indexOf rather than a regex so
// the last-closing-tag rule below stays explicit.
//
// Element layout: [0] the rendered template, starting at `§ Role`; any harness
// elements after it (eval prelude, `# Browser Relay`, ...); for a subagent, its own
// prompt, which embeds the parent's free text; the project element, starting with
// `<project-context>` then a `<critical>` block then trailing text (`# Memory`, user
// instructions); then anything extensions appended. Free text may quote any marker, so
// an element is identified by how it starts, never by what it mentions.

const TEMPLATE_HEADING = "§ Role";
const PROJECT_OPEN = "<project-context>";
const PROJECT_CLOSE = "</project-context>";
const CRITICAL_OPEN = "<critical>";
const CRITICAL_CLOSE = "</critical>";
const SKILLS_HEADING = "# Skills & Rules";

/** Elements omp renders between the template and the project element that are harness
 *  guidance, not user content. Any other element there is forwarded. */
const HARNESS_ELEMENT_HEADINGS = ["# Browser Relay"];

/** The prompt does not have the shape this extractor was written against: omp changed
 *  its template, or the host is not the omp it was recorded from. `missing` is the
 *  marker that was expected. */
export class OmpPromptShapeError extends Error {
	readonly missing: string;
	constructor(missing: string, detail?: string) {
		super(`omp system prompt has an unexpected shape: ${missing} not found${detail ? ` (${detail})` : ""}`);
		this.name = "OmpPromptShapeError";
		this.missing = missing;
	}
}

/** The blocks omp renders under `# Skills & Rules`, in template order. */
const SKILLS_BLOCKS = [
	["<skills>", "</skills>"],
	["<generic-rules>", "</generic-rules>"],
	["<domain-rules>", "</domain-rules>"],
] as const;

/** `[start, end)` of `open`..`close` inclusive, from the first `open` to the first `close` after it. */
function blockSpan(text: string, open: string, close: string): [number, number] | undefined {
	const start = text.indexOf(open);
	if (start < 0) return undefined;
	const end = text.indexOf(close, start);
	return end < 0 ? undefined : [start, end + close.length];
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
	// omp appends the project element last; a subagent's own element before it may quote the tag.
	let projectIndex = -1;
	for (let i = systemPrompt.length - 1; i >= 1; i--) {
		if (systemPrompt[i].trimStart().startsWith(PROJECT_OPEN)) {
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

	// From the `# Skills & Rules` heading through the end of the last skills or rules
	// block, so omp's directive to read a matching skill travels with the list. One
	// section, `omp-skills`, holds skills and rules alike.
	const headingLine = template.indexOf(`\n${SKILLS_HEADING}`);
	const skillsHeading = template.startsWith(SKILLS_HEADING) ? 0 : headingLine < 0 ? -1 : headingLine + 1;
	const spans = SKILLS_BLOCKS.map(([o, c]) => blockSpan(template, o, c)).filter((b): b is [number, number] => b !== undefined);
	if (spans.length > 0) {
		const start = Math.min(...spans.map(([from]) => from), ...(skillsHeading >= 0 ? [skillsHeading] : []));
		sections["omp-skills"] = template.slice(start, Math.max(...spans.map(([, to]) => to)));
	}

	// omp renders the `# Skills & Rules` heading only with something under it. Finding
	// the heading but none of the blocks, or an element that omp rendered as the skills
	// section, means the template moved and skills would be silently lost. Other elements
	// (a subagent's prompt, extension text, the project element with its user
	// instructions) are free text that may quote the tag, so only how an element starts
	// counts.
	if (skillsHeading >= 0 && spans.length === 0) throw new OmpPromptShapeError("<skills>");
	for (let i = 1; i < systemPrompt.length; i++) {
		if (i === projectIndex) continue;
		const head = systemPrompt[i].trimStart();
		if (head.startsWith(SKILLS_HEADING) || head.startsWith("<skills>")) {
			throw new OmpPromptShapeError("<skills> in the template element", `skills section found in element ${i}`);
		}
	}

	// The personality's own sub-headings are `# ` too, so it runs to the next `§`.
	const personality = section(template, "# Personality", ["§ "]);
	if (personality) sections["omp-personality"] = personality;

	const internalUrls = section(template, "# Internal URLs", ["# ", "§ "]);
	if (internalUrls) sections["omp-internal-urls"] = internalUrls;

	// Discoverable tools (MCP servers, ast_grep, lsp, memory, ...) are mounted as xd://
	// devices instead of being listed as tools; this section teaches the mechanism and
	// carries the catalog. Its `## Additional devices` sub-heading stays inside.
	const xdDevices = section(template, "# xd:// Tool Devices", ["# ", "§ "]);
	if (xdDevices) sections["omp-xd-devices"] = xdDevices;

	// Everything but the project element and omp's known harness elements is user or
	// extension text, in array order.
	let extra = 0;
	for (let i = 1; i < systemPrompt.length; i++) {
		const element = systemPrompt[i];
		if (i === projectIndex || !element.trim()) continue;
		if (i < projectIndex) {
			const head = element.trimStart();
			if (HARNESS_ELEMENT_HEADINGS.some((h) => head.startsWith(h))) continue;
		}
		sections[`omp-extra-${++extra}`] = element;
	}

	// What follows the project context: a `<critical>` block (omp's delivery reminders,
	// harness), then omp's memory guidance and the user's instructions, both forwarded:
	// `learn`/`manage_skill` are bridged and memory is reachable through xd://.
	let trailing = projectElement.slice(closeEnd).trimStart();
	if (trailing.startsWith(CRITICAL_OPEN)) {
		const criticalEnd = trailing.indexOf(CRITICAL_CLOSE);
		if (criticalEnd < 0) throw new OmpPromptShapeError(CRITICAL_CLOSE);
		trailing = trailing.slice(criticalEnd + CRITICAL_CLOSE.length);
	}
	trailing = trailing.trim();

	return {
		contextFiles: [],
		skills: [],
		sections,
		...(trailing ? { appendSystemPrompt: trailing } : {}),
	};
}
