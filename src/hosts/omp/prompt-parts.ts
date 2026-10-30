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
const SKILLS_HEADING = "# Skills & Rules";

/** Elements omp renders between the template and the project element that are harness
 *  guidance, not user content. Any other element there is forwarded. */
const HARNESS_ELEMENT_HEADINGS = ["# Browser Relay"];

/** Headings of omp-shipped prose in the text after the project context, with the
 *  deepest heading level that still ends the section. `# Memory` ends at any heading
 *  (so the `## User Instructions` that follows it survives); an unrecognised heading
 *  is always kept, so a new section errs toward forwarding user text. */
const HARNESS_TRAILING_SECTIONS: Record<string, number> = {
	"# Memory": 6,
	"## Auto-Learn (experimental)": 2,
};

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

/** The heading level of a markdown heading line, or 0. */
function headingLevel(line: string): number {
	let level = 0;
	while (level < line.length && line[level] === "#") level++;
	return level >= 1 && level <= 6 && line[level] === " " ? level : 0;
}

/** `text` without omp's own memory guidance sections. Headings inside fenced code are not headings. */
function dropHarnessTrailingSections(text: string): string {
	const kept: string[] = [];
	let inFence = false;
	let dropUntilLevel = 0; // 0: not dropping
	for (const line of text.split("\n")) {
		if (line.startsWith("```")) inFence = !inFence;
		const level = inFence ? 0 : headingLevel(line);
		if (level > 0) {
			if (dropUntilLevel > 0 && level <= dropUntilLevel) dropUntilLevel = 0;
			if (dropUntilLevel === 0 && line.trimEnd() in HARNESS_TRAILING_SECTIONS) {
				dropUntilLevel = HARNESS_TRAILING_SECTIONS[line.trimEnd()];
			}
		}
		if (dropUntilLevel === 0) kept.push(line);
	}
	return kept.join("\n").trim();
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

	// omp renders the `# Skills & Rules` heading only with something under it. Finding
	// the heading but none of the blocks, or the skills elsewhere, means the template
	// moved and skills would be silently lost. The project-context block is user text
	// that may quote the tag, so it is not searched.
	const skillsHeading = template.startsWith(SKILLS_HEADING) ? 0 : template.indexOf(`\n${SKILLS_HEADING}`);
	if (skillsHeading >= 0 && !skills && rules.length === 0) throw new OmpPromptShapeError("<skills>");
	for (let i = 1; i < systemPrompt.length; i++) {
		const element = i === projectIndex ? projectElement.slice(0, open) + projectElement.slice(closeEnd) : systemPrompt[i];
		if (element.includes("<skills>")) throw new OmpPromptShapeError("<skills> in element 0");
	}

	// The personality's own sub-headings are `# ` too, so it runs to the next `§`.
	const personality = section(template, "# Personality", ["§ "]);
	if (personality) sections["omp-personality"] = personality;

	const internalUrls = section(template, "# Internal URLs", ["# ", "§ "]);
	if (internalUrls) sections["omp-internal-urls"] = internalUrls;

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
	// harness), then omp's memory guidance (harness) and the user's instructions.
	let trailing = projectElement.slice(closeEnd).trimStart();
	if (trailing.startsWith(CRITICAL_OPEN)) {
		const criticalEnd = trailing.indexOf(CRITICAL_CLOSE);
		if (criticalEnd < 0) throw new OmpPromptShapeError(CRITICAL_CLOSE);
		trailing = trailing.slice(criticalEnd + CRITICAL_CLOSE.length);
	}
	trailing = dropHarnessTrailingSections(trailing);

	return {
		contextFiles: [],
		skills: [],
		sections,
		...(trailing ? { appendSystemPrompt: trailing } : {}),
	};
}
