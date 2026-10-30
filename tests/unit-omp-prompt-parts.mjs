import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractOmpPromptParts, OmpPromptShapeError } from "../src/hosts/omp/prompt-parts.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/omp-18.14/system-prompt.json", import.meta.url), "utf8"),
).systemPrompt;

const allText = (parts) =>
	[...Object.values(parts.sections ?? {}), parts.appendSystemPrompt ?? ""].join("\n");

describe("omp prompt-parts extractor (omp 18.14 fixture)", () => {
	it("extracts the project context with the AGENTS rule", () => {
		const { sections } = extractOmpPromptParts(fixture);
		const ctx = sections["omp-project-context"];
		assert.ok(ctx.includes("FIXTURE-AGENTS-RULE"));
		assert.ok(ctx.startsWith("<project-context>"));
		assert.ok(ctx.endsWith("</project-context>"));
		assert.ok(!ctx.includes("<critical>"));
	});

	it("extracts the skills section from its heading through the skills block", () => {
		const { sections } = extractOmpPromptParts(fixture);
		const skills = sections["omp-skills"];
		assert.ok(skills.includes("FIXTURE-SKILL"));
		assert.ok(skills.startsWith("# Skills & Rules\n"));
		assert.ok(skills.endsWith("</skills>"));
		assert.ok(!skills.includes("§ Runtime"));
		assert.ok(!skills.includes("# Internal URLs"));
	});

	it("the skills section carries omp's read-skill directive", () => {
		const { sections } = extractOmpPromptParts(fixture);
		assert.ok(sections["omp-skills"].includes("Matching skill → MUST read `skill://<name>` first.\n<skills>"));
	});

	it("extracts the personality and internal URLs sections", () => {
		const { sections } = extractOmpPromptParts(fixture);
		assert.ok(sections["omp-personality"].startsWith("# Personality"));
		assert.ok(sections["omp-personality"].includes("# Escalation"));
		assert.ok(!sections["omp-personality"].includes("§ Runtime"));
		assert.ok(sections["omp-internal-urls"].startsWith("# Internal URLs"));
		assert.ok(sections["omp-internal-urls"].includes("`skill://<name>`"));
		assert.ok(!sections["omp-internal-urls"].includes("# Tool Inventory"));
	});

	it("forwards extension-appended elements verbatim", () => {
		const { sections } = extractOmpPromptParts(fixture);
		assert.equal(sections["omp-extra-1"], "FIXTURE-EXTENSION-APPEND");
		assert.ok(Object.values(sections).includes("FIXTURE-EXTENSION-APPEND"));
	});

	it("takes the text after the trailing critical block as the append text", () => {
		const parts = extractOmpPromptParts(fixture);
		assert.ok(parts.appendSystemPrompt.includes("## User Instructions"));
		assert.ok(!parts.appendSystemPrompt.includes("# Memory"));
		assert.ok(!parts.appendSystemPrompt.includes("Auto-Learn"));
		assert.ok(!parts.appendSystemPrompt.includes("<critical>"));
		assert.ok(!parts.appendSystemPrompt.includes("</project-context>"));
	});

	it("returns no context files or skills for the host seam to record", () => {
		const parts = extractOmpPromptParts(fixture);
		assert.deepEqual(parts.contextFiles, []);
		assert.deepEqual(parts.skills, []);
	});

	it("drops omp harness instructions", () => {
		const text = allText(extractOmpPromptParts(fixture));
		for (const dropped of ["§ Tool Policy", "§ Workflow", "# Tool Inventory", "§ Role", "<critical>", "# Browser Relay"]) {
			assert.ok(!text.includes(dropped), `output must not contain ${dropped}`);
		}
	});

	it("omits generic and domain rules absent from the fixture", () => {
		const { sections } = extractOmpPromptParts(fixture);
		assert.ok(!("omp-rules" in sections));
		assert.ok(!sections["omp-skills"].includes("-rules>"));
	});
});

describe("omp prompt-parts extractor (synthetic prompts)", () => {
	const role = "§ Role\nYou are omp.";
	const project = "<project-context>\n<workstation>w</workstation>\n</project-context>";

	it("omits absent optional blocks", () => {
		const parts = extractOmpPromptParts([role, project]);
		assert.deepEqual(Object.keys(parts.sections), ["omp-project-context"]);
		assert.equal(parts.appendSystemPrompt, undefined);
	});

	it("extracts generic and domain rules into the skills section", () => {
		const generic = "<generic-rules>\ng1\n</generic-rules>";
		const domain = "<domain-rules>\nd1\n</domain-rules>";
		const { sections } = extractOmpPromptParts([`${role}\n\n${generic}\n${domain}\n\n§ Workflow\nx`, project]);
		assert.equal(sections["omp-skills"], `${generic}\n${domain}`);
		assert.ok(!("omp-rules" in sections));
		const only = extractOmpPromptParts([`${role}\n${domain}`, project]).sections["omp-skills"];
		assert.equal(only, domain);
	});

	it("forwards the whole Skills & Rules section, directive, skills and rules, as one section", () => {
		const body = [
			"# Skills & Rules",
			"Matching skill → MUST read `skill://<name>` first.",
			"<skills>",
			"- a: b",
			"</skills>",
			"",
			"<generic-rules>",
			"g1",
			"</generic-rules>",
			"",
			"<domain-rules>",
			"- d (*.ts): d1",
			"</domain-rules>",
		].join("\n");
		const { sections } = extractOmpPromptParts([`${role}\n§ Runtime\n${body}\n\n# Internal URLs\nx`, project]);
		assert.equal(sections["omp-skills"], body);
		assert.ok(!("omp-rules" in sections));
	});

	it("keeps a project-context block whose content contains the closing tag", () => {
		const element = [
			"<project-context>",
			"<repo-rules>",
			"Never write </project-context> by hand.",
			"</repo-rules>",
			"</project-context>",
			"",
			"<critical>",
			"- c",
			"</critical>",
			"",
			"## User Instructions",
		].join("\n");
		const parts = extractOmpPromptParts([role, element]);
		const ctx = parts.sections["omp-project-context"];
		assert.ok(ctx.includes("Never write </project-context> by hand.\n</repo-rules>"));
		assert.ok(ctx.endsWith("</repo-rules>\n</project-context>"));
		assert.equal(parts.appendSystemPrompt, "## User Instructions");
	});

	it("uses the text after the project context as the append text when no critical block follows", () => {
		const parts = extractOmpPromptParts([role, `${project}\n\n## User Instructions\nu`]);
		assert.equal(parts.appendSystemPrompt, "## User Instructions\nu");
	});

	it("drops elements between the template and the project element and numbers later ones", () => {
		const parts = extractOmpPromptParts([role, "# Browser Relay\nharness", project, "first", "second"]);
		assert.equal(parts.sections["omp-extra-1"], "first");
		assert.equal(parts.sections["omp-extra-2"], "second");
		assert.ok(!allText(parts).includes("Browser Relay"));
	});

	it("throws OmpPromptShapeError naming <project-context> when absent", () => {
		assert.throws(
			() => extractOmpPromptParts([role, "no project here"]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "<project-context>",
		);
	});

	it("throws OmpPromptShapeError naming the template heading when element 0 is unrecognized", () => {
		assert.throws(
			() => extractOmpPromptParts(["something else", project]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "§ Role",
		);
		assert.throws(
			() => extractOmpPromptParts([]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "§ Role",
		);
	});

	it("drops omp's Memory and Auto-Learn guidance but keeps user instructions and unknown sections", () => {
		const trailing = [
			"# Memory", "memory prose", "- bullet",
			"## Auto-Learn (experimental)", "learn prose", "```", "# not a heading", "```",
			"## User Instructions", "USER-TEXT",
			"## Something New", "NEW-SECTION-TEXT",
		].join("\n");
		const parts = extractOmpPromptParts([role, `${project}\n\n${trailing}`]);
		assert.equal(parts.appendSystemPrompt, "## User Instructions\nUSER-TEXT\n## Something New\nNEW-SECTION-TEXT");
	});

	it("omits the append text when only omp's memory guidance follows the project context", () => {
		const parts = extractOmpPromptParts([role, `${project}\n\n# Memory\nm\n## Auto-Learn (experimental)\nl`]);
		assert.equal(parts.appendSystemPrompt, undefined);
	});

	it("forwards a middle element that is not a known harness element", () => {
		const parts = extractOmpPromptParts([role, "# Browser Relay\nharness", "USER-MIDDLE", project, "after"]);
		assert.equal(parts.sections["omp-extra-1"], "USER-MIDDLE");
		assert.equal(parts.sections["omp-extra-2"], "after");
		assert.ok(!allText(parts).includes("harness"));
	});

	it("throws naming <skills> when the skills heading has no skills or rules under it", () => {
		assert.throws(
			() => extractOmpPromptParts([`${role}\n# Skills & Rules\nMatching skill.\n# Internal URLs\nx`, project]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "<skills>",
		);
	});

	it("does not throw when omp rendered no skills heading", () => {
		assert.doesNotThrow(() => extractOmpPromptParts([role, project]));
	});

	it("throws naming <skills> in the template element when the skills block is in another element", () => {
		assert.throws(
			() => extractOmpPromptParts([role, "<skills>\n- a: b\n</skills>", project]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "<skills> in the template element"
				&& err.message.includes("element 1"),
		);
	});

	it("lets repo rules inside the project context quote <skills>", () => {
		const quoting = "<project-context>\n<repo-rules>use <skills> wisely</repo-rules>\n</project-context>";
		assert.doesNotThrow(() => extractOmpPromptParts([role, quoting]));
	});

	it("throws naming </critical> when the critical block after the project context is unclosed", () => {
		assert.throws(
			() => extractOmpPromptParts([role, `${project}\n\n<critical>\n- c\n\n## User Instructions\nu`]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "</critical>",
		);
	});
});

describe("omp prompt-parts extractor (free text quoting omp markers)", () => {
	// omp builds a subagent's prompt as [...defaultPrompt.slice(0, -1), subagentPrompt, project]
	// (task/executor.ts); extensions append after that.
	const [template, relay, projectElement, appended] = fixture;
	const subagentPrompt = (text) => [template, relay, text, projectElement, appended];

	it("a subagent element quoting <skills> does not throw", () => {
		const subagent = "You are a subagent.\n\nParent context: the template lists skills in <skills>...</skills>.";
		const parts = extractOmpPromptParts(subagentPrompt(subagent));
		assert.equal(parts.sections["omp-extra-1"], subagent);
		assert.ok(parts.sections["omp-skills"].includes("FIXTURE-SKILL"));
	});

	it("a subagent element quoting <project-context> and </project-context> is forwarded as an extra while the real project element is used", () => {
		const subagent = "You are a subagent.\n\nParent context: omp wraps repo rules in <project-context> ... </project-context>.";
		const parts = extractOmpPromptParts(subagentPrompt(subagent));
		const ctx = parts.sections["omp-project-context"];
		assert.ok(ctx.startsWith("<project-context>"));
		assert.ok(ctx.includes("FIXTURE-AGENTS-RULE"));
		assert.equal(parts.sections["omp-extra-1"], subagent);
		assert.equal(parts.sections["omp-extra-2"], "FIXTURE-EXTENSION-APPEND");
		assert.ok(parts.appendSystemPrompt.includes("## User Instructions"));
		const text = allText(parts);
		for (const dropped of ["<critical>", "# Memory", "Auto-Learn"]) {
			assert.ok(!text.includes(dropped), `output must not contain ${dropped}`);
		}
	});

	it("takes the last element that starts with <project-context> as the project element", () => {
		const decoy = "<project-context>\n<workstation>decoy</workstation>\n</project-context>";
		const parts = extractOmpPromptParts([template, relay, decoy, projectElement]);
		assert.ok(parts.sections["omp-project-context"].includes("FIXTURE-AGENTS-RULE"));
		assert.equal(parts.sections["omp-extra-1"], decoy);
	});

	it("a user instruction mentioning <skills> does not throw", () => {
		const parts = extractOmpPromptParts([template, relay, `${projectElement}\nCheck <skills> before acting.`, appended]);
		assert.ok(parts.appendSystemPrompt.endsWith("Check <skills> before acting."));
	});

	it("an extension element mentioning <skills> mid-text does not throw", () => {
		const parts = extractOmpPromptParts([template, relay, projectElement, "Prefer the entries in <skills>."]);
		assert.equal(parts.sections["omp-extra-1"], "Prefer the entries in <skills>.");
	});

	it("throws when an element outside the template starts with the skills heading", () => {
		assert.throws(
			() => extractOmpPromptParts(["§ Role\nYou are omp.", "# Skills & Rules\nMatching skill.\n<skills>\n- a: b\n</skills>", projectElement]),
			(err) => err instanceof OmpPromptShapeError && err.missing === "<skills> in the template element",
		);
	});
});

