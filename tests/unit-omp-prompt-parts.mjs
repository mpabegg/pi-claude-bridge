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

	it("extracts the skills block", () => {
		const { sections } = extractOmpPromptParts(fixture);
		const skills = sections["omp-skills"];
		assert.ok(skills.includes("FIXTURE-SKILL"));
		assert.ok(skills.startsWith("<skills>"));
		assert.ok(skills.endsWith("</skills>"));
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
		assert.ok(parts.appendSystemPrompt.startsWith("# Memory"));
		assert.ok(parts.appendSystemPrompt.includes("## User Instructions"));
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

	it("extracts generic and domain rules", () => {
		const generic = "<generic-rules>\ng1\n</generic-rules>";
		const domain = "<domain-rules>\nd1\n</domain-rules>";
		const { sections } = extractOmpPromptParts([`${role}\n\n${generic}\n${domain}\n\n§ Workflow\nx`, project]);
		assert.equal(sections["omp-rules"], `${generic}\n${domain}`);
		const only = extractOmpPromptParts([`${role}\n${domain}`, project]).sections["omp-rules"];
		assert.equal(only, domain);
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
			"# Memory",
		].join("\n");
		const parts = extractOmpPromptParts([role, element]);
		const ctx = parts.sections["omp-project-context"];
		assert.ok(ctx.includes("Never write </project-context> by hand.\n</repo-rules>"));
		assert.ok(ctx.endsWith("</repo-rules>\n</project-context>"));
		assert.equal(parts.appendSystemPrompt, "# Memory");
	});

	it("uses the text after the project context as the append text when no critical block follows", () => {
		const parts = extractOmpPromptParts([role, `${project}\n\n# Memory\nm`]);
		assert.equal(parts.appendSystemPrompt, "# Memory\nm");
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
});
